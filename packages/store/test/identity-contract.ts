import { describe, expect, it } from "vitest";
import { LastAdminError, roleAtLeast, type AuditInput, type CertificateRecord, type DeviceAuthInput, type IdentityStore, type Principal } from "../src/index.js";

const NOW = 1_800_000_000_000;
const audit = (action: string, target = "t"): AuditInput => ({ atMs: NOW, actor: "system", action, target });
const serial = (n: number) => new Uint8Array(16).fill(n);
export const cert = (n: number, principalId: string, over: Partial<CertificateRecord> = {}): CertificateRecord => ({
  serial: serial(n),
  principalId,
  keyId: new Uint8Array(8).fill(n),
  publicKey: new Uint8Array(32).fill(n),
  issuedAtMs: NOW,
  notBeforeMs: NOW,
  notAfterMs: NOW + 86_400_000,
  ...over,
});

async function person(s: IdentityStore, sub: string, orgRole: "member" | "admin" = "member"): Promise<Principal> {
  return s.upsertPrincipal(
    { oidcIssuer: "https://idp.example", oidcSubject: sub, email: `${sub}@example.com`, displayName: sub, orgRole },
    audit("auth.login", ""),
  );
}

/** Behaviour every IdentityStore must have, run against memory and Postgres alike. */
export function identityStoreContract(name: string, make: () => Promise<IdentityStore>): void {
  describe(`${name} IdentityStore contract`, () => {
    it("upsert is stable per OIDC identity, refreshes attributes and never re-enables", async () => {
      const s = await make();
      const a = await person(s, "alice");
      const again = await s.upsertPrincipal(
        { oidcIssuer: "https://idp.example", oidcSubject: "alice", email: "new@example.com", displayName: "Alice A", orgRole: "admin" },
        audit("auth.login", ""),
      );
      expect(again.id).toBe(a.id);
      expect(again).toMatchObject({ email: "new@example.com", orgRole: "admin" });
      expect((await person(s, "bob")).id).not.toBe(a.id);
      expect(a.id).toMatch(/^[A-Za-z0-9._:@-]+$/); // usable as a certificate subject

      await s.disablePrincipal(a.id, NOW, audit("principal.disable", a.id));
      const after = await person(s, "alice");
      expect(after.disabledAtMs).toBe(NOW);
      expect((await s.getPrincipal(a.id))?.disabledAtMs).toBe(NOW);
      expect(await s.getPrincipal("nope")).toBeUndefined();
      await s.close();
    });

    it("records certificates and revokes each exactly once", async () => {
      const s = await make();
      const a = await person(s, "alice");
      await s.recordCertificate(cert(1, a.id), audit("cert.issue"));
      const got = await s.getCertificate(serial(1));
      expect(got).toMatchObject({ principalId: a.id, notAfterMs: NOW + 86_400_000 });
      expect([...(got?.keyId ?? [])]).toEqual(Array(8).fill(1));
      expect(got?.revokedAtMs).toBeUndefined();
      await expect(s.recordCertificate(cert(1, a.id), audit("cert.issue"))).rejects.toThrow();
      await expect(s.recordCertificate(cert(2, "ghost"), audit("cert.issue"))).rejects.toThrow();

      expect(await s.revokeCertificate(serial(1), NOW + 5, "lost_device", audit("cert.revoke"))).toBe(true);
      expect(await s.revokeCertificate(serial(1), NOW + 9, "again", audit("cert.revoke"))).toBe(false);
      expect(await s.revokeCertificate(serial(99), NOW, "x", audit("cert.revoke"))).toBe(false);
      expect(await s.getCertificate(serial(1))).toMatchObject({ revokedAtMs: NOW + 5, revokeReason: "lost_device" });
      expect(await s.getCertificate(serial(42))).toBeUndefined();
      await s.close();
    });

    it("grants are upserts, listable, removable, and roles are totally ordered", async () => {
      const s = await make();
      const a = await person(s, "alice");
      const b = await person(s, "bob");
      await s.setGrant("doc", a.id, "admin", "system", NOW, audit("grant.set"));
      await s.setGrant("doc", b.id, "read", a.id, NOW, audit("grant.set"));
      await s.setGrant("doc", b.id, "write", a.id, NOW + 1, audit("grant.set"));
      expect(await s.roleOf("doc", b.id)).toBe("write");
      expect(await s.roleOf("other", b.id)).toBeUndefined();
      expect((await s.listGrants("doc")).map((g) => [g.principalId === a.id ? "a" : "b", g.role])).toEqual(
        a.id < b.id ? [["a", "admin"], ["b", "write"]] : [["b", "write"], ["a", "admin"]],
      );
      expect(await s.removeGrant("doc", b.id, audit("grant.remove"))).toBe(true);
      expect(await s.removeGrant("doc", b.id, audit("grant.remove"))).toBe(false);
      expect(await s.roleOf("doc", b.id)).toBeUndefined();
      await expect(s.setGrant("doc", "ghost", "read", "system", NOW, audit("grant.set"))).rejects.toThrow();

      expect(roleAtLeast("admin", "merge") && roleAtLeast("merge", "write") && roleAtLeast("write", "read")).toBe(true);
      expect(roleAtLeast("read", "write")).toBe(false);
      await s.close();
    });

    it("keepOneAdmin refuses demoting or removing the last enabled admin, atomically with the write", async () => {
      const s = await make();
      const a = await person(s, "alice");
      const b = await person(s, "bob");
      const keep = { keepOneAdmin: true };
      await s.setGrant("doc", a.id, "admin", "system", NOW, audit("grant.set"));
      await expect(s.setGrant("doc", a.id, "read", a.id, NOW, audit("grant.set"), keep)).rejects.toBeInstanceOf(LastAdminError);
      await expect(s.removeGrant("doc", a.id, audit("grant.remove"), keep)).rejects.toBeInstanceOf(LastAdminError);
      expect(await s.roleOf("doc", a.id)).toBe("admin"); // nothing changed
      expect((await s.listAudit(0, 100)).filter((e) => e.action === "grant.remove")).toHaveLength(0); // and nothing was audited

      // Changing a non-admin, or promoting, is always fine under the guard.
      await s.setGrant("doc", b.id, "read", a.id, NOW, audit("grant.set"), keep);
      await s.setGrant("doc", b.id, "admin", a.id, NOW, audit("grant.set"), keep);
      await s.setGrant("doc", a.id, "read", a.id, NOW, audit("grant.set"), keep); // bob is a second admin
      await expect(s.removeGrant("doc", b.id, audit("grant.remove"), keep)).rejects.toBeInstanceOf(LastAdminError);

      // A disabled admin does not count as one.
      await s.setGrant("doc", a.id, "admin", b.id, NOW, audit("grant.set"));
      await s.disablePrincipal(a.id, NOW, audit("principal.disable", a.id));
      await expect(s.setGrant("doc", b.id, "write", b.id, NOW, audit("grant.set"), keep)).rejects.toBeInstanceOf(LastAdminError);
      await s.close();
    });

    it("two admins demoting each other at once cannot both succeed", async () => {
      const s = await make();
      const a = await person(s, "alice");
      const b = await person(s, "bob");
      const keep = { keepOneAdmin: true };
      // Open several connections first so both changes really run at the same time.
      await Promise.all([s.ping(), s.ping(), s.ping(), s.ping()]);
      for (let round = 0; round < 5; round++) {
        const doc = `race-${round}`;
        await s.setGrant(doc, a.id, "admin", "system", NOW, audit("grant.set"));
        await s.setGrant(doc, b.id, "admin", "system", NOW, audit("grant.set"));
        const results = await Promise.allSettled([
          s.setGrant(doc, a.id, "read", b.id, NOW, audit("grant.set"), keep),
          s.setGrant(doc, b.id, "read", a.id, NOW, audit("grant.set"), keep),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect((await s.listGrants(doc)).filter((g) => g.role === "admin")).toHaveLength(1);
      }
      await s.close();
    });

    it("authorize answers per query in order with the right reason", async () => {
      const s = await make();
      const a = await person(s, "alice", "admin");
      const b = await person(s, "bob");
      const c = await person(s, "carol");
      await s.recordCertificate(cert(1, a.id), audit("cert.issue"));
      await s.recordCertificate(cert(2, b.id), audit("cert.issue"));
      await s.recordCertificate(cert(3, c.id), audit("cert.issue"));
      await s.setGrant("doc", a.id, "admin", "system", NOW, audit("grant.set"));
      await s.setGrant("doc", b.id, "write", a.id, NOW, audit("grant.set"));
      await s.setGrant("doc", c.id, "read", a.id, NOW, audit("grant.set"));

      const q = (n: number, id: string, doc = "doc") => ({ serial: serial(n), principalId: id, documentId: doc });
      expect(await s.authorize([])).toEqual([]);
      expect(await s.authorize([q(1, a.id), q(2, b.id), q(3, c.id), q(2, b.id, "elsewhere"), q(9, a.id), q(1, b.id)])).toEqual([
        { ok: true, role: "admin", orgRole: "admin" },
        { ok: true, role: "write", orgRole: "member" },
        { ok: true, role: "read", orgRole: "member" },
        { ok: false, reason: "no_access" },
        { ok: false, reason: "unknown_certificate" },
        { ok: false, reason: "unknown_certificate" }, // right serial, wrong subject
      ]);

      await s.revokeCertificate(serial(2), NOW, "r", audit("cert.revoke"));
      expect((await s.authorize([q(2, b.id)]))[0]).toEqual({ ok: false, reason: "revoked" });

      expect(await s.disablePrincipal(c.id, NOW, audit("principal.disable", c.id))).toBe(1);
      expect((await s.authorize([q(3, c.id)]))[0]).toEqual({ ok: false, reason: "revoked" }); // certificates revoked with the principal
      expect(await s.getCertificate(serial(3))).toMatchObject({ revokeReason: "principal_disabled" });
      expect(await s.disablePrincipal("ghost", NOW, audit("principal.disable"))).toBe(0);

      // Defence in depth: a certificate that somehow exists for a disabled principal is still refused.
      await s.recordCertificate(cert(4, c.id), audit("cert.issue"));
      expect((await s.authorize([q(4, c.id)]))[0]).toEqual({ ok: false, reason: "disabled" });

      await s.removeGrant("doc", a.id, audit("grant.remove"));
      expect((await s.authorize([q(1, a.id)]))[0]).toEqual({ ok: false, reason: "no_access" });
      await s.close();
    });

    it("audit trail is ordered, complete and carries every mutation", async () => {
      const s = await make();
      const a = await person(s, "alice");
      await s.recordCertificate(cert(1, a.id), audit("cert.issue", "s1"));
      await s.setGrant("doc", a.id, "admin", "system", NOW, audit("grant.set", "doc"));
      await s.revokeCertificate(serial(1), NOW, "r", audit("cert.revoke", "s1"));
      await s.revokeCertificate(serial(1), NOW, "r", audit("cert.revoke", "s1")); // no-op: not audited
      await s.removeGrant("doc", a.id, audit("grant.remove", "doc"));
      const all = await s.listAudit(0, 100);
      expect(all.map((e) => e.action)).toEqual(["auth.login", "cert.issue", "grant.set", "cert.revoke", "grant.remove"]);
      expect(all.map((e) => e.id)).toEqual([...all.map((e) => e.id)].sort((x, y) => x - y));
      expect(all[0]?.target).toBe(a.id); // empty target defaults to the principal
      const page = await s.listAudit(all[1]?.id ?? 0, 2);
      expect(page.map((e) => e.action)).toEqual(["grant.set", "cert.revoke"]);
      await s.close();
    });

    it("keeps the signed certificate bytes and lists certificates in serial order", async () => {
      const s = await make();
      const a = await person(s, "alice");
      const bytes = new Uint8Array([9, 8, 7]);
      await s.recordCertificate(cert(3, a.id, { certificate: bytes }), audit("cert.issue"));
      await s.recordCertificate(cert(1, a.id), audit("cert.issue"));
      await s.recordCertificate(cert(2, a.id, { certificate: bytes }), audit("cert.issue"));
      expect([...((await s.getCertificate(serial(3)))?.certificate ?? [])]).toEqual([9, 8, 7]);
      expect((await s.getCertificate(serial(1)))?.certificate).toBeUndefined();
      const all = await s.listCertificates(undefined, 10);
      expect(all.map((x) => x.serial[0])).toEqual([1, 2, 3]);
      expect((await s.listCertificates(serial(1), 1)).map((x) => x.serial[0])).toEqual([2]);
      expect(await s.listCertificates(serial(3), 10)).toEqual([]);
      await s.close();
    });

    it("registers a document, makes the creator its admin and audits it, atomically and once", async () => {
      const s = await make();
      const a = await person(s, "alice");
      const id = "0b6f0f0e-7d2c-4c5e-9b0a-1f2e3d4c5b6a";
      expect(await s.getDocument(id)).toBeUndefined();
      expect(await s.createDocument(id, a.id, NOW, audit("document.create", id))).toBe(true);
      expect(await s.getDocument(id)).toEqual({ id, createdBy: a.id, createdAtMs: NOW });
      expect(await s.roleOf(id, a.id)).toBe("admin");
      expect(await s.createDocument(id, a.id, NOW + 1, audit("document.create", id))).toBe(false);
      expect((await s.getDocument(id))?.createdAtMs).toBe(NOW);
      const created = (await s.listAudit(0, 100)).filter((e) => e.action === "document.create");
      expect(created).toHaveLength(1);
      await expect(s.createDocument("other", "ghost", NOW, audit("document.create"))).rejects.toThrow();
      expect(await s.getDocument("other")).toBeUndefined();
      await s.close();
    });

    it("lists principals and documents in ascending id order, `after` exclusive, without gaps", async () => {
      const s = await make();
      const people: Principal[] = [];
      for (let i = 0; i < 7; i++) people.push(await person(s, `user${i}`));
      const sorted = people.map((p) => p.id).sort();
      const seen: string[] = [];
      for (let after: string | undefined; ; ) {
        const page = await s.listPrincipals(after, 3);
        expect(page.length).toBeLessThanOrEqual(3);
        seen.push(...page.map((p) => p.id));
        const last = page[page.length - 1];
        if (page.length < 3 || !last) break;
        after = last.id;
      }
      expect(seen).toEqual(sorted);
      expect(await s.listPrincipals(sorted[6], 3)).toEqual([]);
      await s.disablePrincipal(people[0]?.id ?? "", NOW, audit("principal.disable"));
      expect((await s.listPrincipals(undefined, 100)).find((p) => p.id === people[0]?.id)?.disabledAtMs).toBe(NOW);

      const owner = people[1]?.id ?? "";
      const ids = ["0b6f0f0e-7d2c-4c5e-9b0a-1f2e3d4c5b6a", "1b6f0f0e-7d2c-4c5e-9b0a-1f2e3d4c5b6a", "2b6f0f0e-7d2c-4c5e-9b0a-1f2e3d4c5b6a", "3b6f0f0e-7d2c-4c5e-9b0a-1f2e3d4c5b6a"];
      for (const id of [ids[2], ids[0], ids[3], ids[1]]) await s.createDocument(id ?? "", owner, NOW, audit("document.create", id));
      expect((await s.listDocumentRecords(undefined, 100)).map((d) => d.id)).toEqual(ids);
      expect((await s.listDocumentRecords(ids[1], 2)).map((d) => d.id)).toEqual([ids[2], ids[3]]);
      expect((await s.listDocumentRecords(undefined, 2)).map((d) => d.id)).toEqual([ids[0], ids[1]]);
      expect(await s.listDocumentRecords(ids[3], 5)).toEqual([]);
      await s.close();
    });

    it("lists one principal's certificates, newest first, and nobody else's", async () => {
      const s = await make();
      const a = await person(s, "alice");
      const b = await person(s, "bob");
      await s.recordCertificate(cert(1, a.id, { issuedAtMs: NOW + 10 }), audit("cert.issue"));
      await s.recordCertificate(cert(2, a.id, { issuedAtMs: NOW + 30 }), audit("cert.issue"));
      await s.recordCertificate(cert(3, b.id, { issuedAtMs: NOW + 20 }), audit("cert.issue"));
      await s.recordCertificate(cert(4, a.id, { issuedAtMs: NOW + 20 }), audit("cert.issue"));
      await s.revokeCertificate(serial(4), NOW + 99, "lost", audit("cert.revoke"));
      const mine = await s.listCertificatesOf(a.id);
      expect(mine.map((c) => c.serial[0])).toEqual([2, 4, 1]);
      expect(mine[1]).toMatchObject({ revokedAtMs: NOW + 99, revokeReason: "lost" });
      expect((await s.listCertificatesOf(b.id)).map((c) => c.serial[0])).toEqual([3]);
      expect(await s.listCertificatesOf("ghost")).toEqual([]);
      await s.close();
    });

    it("appendAudit adds exactly one event and changes nothing else", async () => {
      const s = await make();
      const a = await person(s, "alice");
      const before = (await s.listAudit(0, 100)).length;
      await s.appendAudit({ atMs: NOW + 5, actor: a.id, action: "ledger.export", target: "acme", detail: "x" });
      const all = await s.listAudit(0, 100);
      expect(all).toHaveLength(before + 1);
      expect(all[all.length - 1]).toMatchObject({ atMs: NOW + 5, actor: a.id, action: "ledger.export", target: "acme", detail: "x" });
      expect(await s.listPrincipals(undefined, 10)).toHaveLength(1);
      await s.close();
    });

    describe("device authorisations", () => {
      const dev = (n: number, over: Partial<DeviceAuthInput> = {}): DeviceAuthInput => ({
        deviceHash: new Uint8Array(32).fill(n),
        userCode: "BCDFGHJ" + "KLMNPQRS"[n % 8],
        label: `laptop ${n}`,
        atMs: NOW,
        expiresAtMs: NOW + 600_000,
        ...over,
      });
      const hash = (n: number) => new Uint8Array(32).fill(n);

      it("creates a request that can be read by its user code until it expires, with one audit event", async () => {
        const s = await make();
        const before = (await s.listAudit(0, 100)).length;
        expect(await s.createDeviceAuth(dev(1), audit("device.start", "x"))).toBe(true);
        expect((await s.listAudit(0, 100)).length).toBe(before + 1);
        expect(await s.getDeviceAuth(dev(1).userCode, NOW + 1)).toEqual({ userCode: dev(1).userCode, label: "laptop 1", createdAtMs: NOW, expiresAtMs: NOW + 600_000, status: "pending" });
        expect(await s.getDeviceAuth(dev(1).userCode, NOW + 600_000)).toBeUndefined(); // expiry is exclusive
        expect(await s.getDeviceAuth("ZZZZZZZZ", NOW)).toBeUndefined();
        await s.close();
      });

      it("refuses a user code or device hash that is already in use, changing and auditing nothing", async () => {
        const s = await make();
        expect(await s.createDeviceAuth(dev(1), audit("device.start"))).toBe(true);
        const n = (await s.listAudit(0, 100)).length;
        expect(await s.createDeviceAuth({ ...dev(2), userCode: dev(1).userCode }, audit("device.start"))).toBe(false);
        expect(await s.createDeviceAuth({ ...dev(2), deviceHash: hash(1) }, audit("device.start"))).toBe(false);
        expect((await s.listAudit(0, 100)).length).toBe(n);
        await s.close();
      });

      it("an expired request does not block its user code from being reused", async () => {
        const s = await make();
        await s.createDeviceAuth(dev(1), audit("device.start"));
        expect(await s.createDeviceAuth({ ...dev(2), userCode: dev(1).userCode, atMs: NOW + 700_000, expiresAtMs: NOW + 1_300_000 }, audit("device.start"))).toBe(true);
        expect(await s.pollDeviceAuth(hash(1), NOW + 700_001, 5000)).toEqual({ state: "expired" });
        await s.close();
      });

      it("an expired request that the bounded sweep does not reach still cannot block a new one", async () => {
        const s = await make();
        const letters = "BCDFGHJKLMNPQRSTVWXZ";
        const codeOf = (i: number) => Array.from({ length: 8 }, (_, k) => letters[Math.floor(i / 20 ** k) % 20]).join("");
        for (let i = 0; i < 150; i++) {
          // expiry grows with i, so the oldest are swept first and the newest are left behind
          await s.createDeviceAuth({ deviceHash: new Uint8Array(32).fill(0).map((_, k) => (k === 0 ? i + 1 : 0)), userCode: codeOf(i), label: "", atMs: NOW, expiresAtMs: NOW + 1000 + i }, audit("device.start"));
        }
        const later = NOW + 5000;
        const fresh = new Uint8Array(32).fill(250);
        expect(await s.createDeviceAuth({ deviceHash: fresh, userCode: codeOf(149), label: "", atMs: later, expiresAtMs: later + 600_000 }, audit("device.start"))).toBe(true);
        const newestHash = new Uint8Array(32).fill(0).map((_, k) => (k === 0 ? 149 : 0)); // the hash of request 148
        expect(await s.createDeviceAuth({ deviceHash: newestHash, userCode: codeOf(900), label: "", atMs: later, expiresAtMs: later + 600_000 }, audit("device.start"))).toBe(true);
        await s.close();
      });

      it("pending until decided; approve hands the principal over exactly once", async () => {
        const s = await make();
        const a = await person(s, "alice");
        await s.createDeviceAuth(dev(1), audit("device.start"));
        expect(await s.pollDeviceAuth(hash(1), NOW + 1000, 5000)).toEqual({ state: "pending" });
        expect(await s.decideDeviceAuth(dev(1).userCode, "approve", a.id, NOW + 2000, audit("device.approve"))).toBe("ok");
        expect((await s.getDeviceAuth(dev(1).userCode, NOW + 2000))?.status).toBe("approved");
        expect(await s.pollDeviceAuth(hash(1), NOW + 3000, 5000)).toEqual({ state: "approved", principalId: a.id, userCode: dev(1).userCode, label: "laptop 1" });
        expect(await s.pollDeviceAuth(hash(1), NOW + 9000, 5000)).toEqual({ state: "expired" }); // consumed
        expect(await s.getDeviceAuth(dev(1).userCode, NOW + 3000)).toBeUndefined();
        await s.close();
      });

      it("deny is reported once, and a decision cannot be changed", async () => {
        const s = await make();
        const a = await person(s, "alice");
        await s.createDeviceAuth(dev(1), audit("device.start"));
        await s.createDeviceAuth(dev(2), audit("device.start"));
        expect(await s.decideDeviceAuth(dev(1).userCode, "deny", a.id, NOW + 10, audit("device.deny"))).toBe("ok");
        expect(await s.decideDeviceAuth(dev(1).userCode, "approve", a.id, NOW + 11, audit("device.approve"))).toBe("decided");
        expect(await s.decideDeviceAuth(dev(2).userCode, "approve", a.id, NOW + 12, audit("device.approve"))).toBe("ok");
        expect(await s.decideDeviceAuth(dev(2).userCode, "deny", a.id, NOW + 13, audit("device.deny"))).toBe("decided");
        expect(await s.pollDeviceAuth(hash(1), NOW + 20, 5000)).toEqual({ state: "denied" });
        expect(await s.pollDeviceAuth(hash(1), NOW + 9000, 5000)).toEqual({ state: "expired" });
        expect(await s.pollDeviceAuth(hash(2), NOW + 9000, 5000)).toEqual({ state: "approved", principalId: a.id, userCode: dev(2).userCode, label: "laptop 2" });
        await s.close();
      });

      it("a refused decision writes no audit event; unknown and expired codes are unknown", async () => {
        const s = await make();
        const a = await person(s, "alice");
        await s.createDeviceAuth(dev(1), audit("device.start"));
        await s.decideDeviceAuth(dev(1).userCode, "approve", a.id, NOW + 1, audit("device.approve"));
        const n = (await s.listAudit(0, 100)).length;
        expect(await s.decideDeviceAuth(dev(1).userCode, "deny", a.id, NOW + 2, audit("device.deny"))).toBe("decided");
        expect(await s.decideDeviceAuth("ZZZZZZZZ", "approve", a.id, NOW + 2, audit("device.approve"))).toBe("unknown");
        expect(await s.decideDeviceAuth(dev(1).userCode, "approve", a.id, NOW + 600_000, audit("device.approve"))).toBe("unknown");
        expect((await s.listAudit(0, 100)).length).toBe(n);
        await s.close();
      });

      it("polling faster than the interval answers slow_down, and that poll counts", async () => {
        const s = await make();
        await s.createDeviceAuth(dev(1), audit("device.start"));
        expect(await s.pollDeviceAuth(hash(1), NOW + 10_000, 5000)).toEqual({ state: "pending" });
        expect(await s.pollDeviceAuth(hash(1), NOW + 12_000, 5000)).toEqual({ state: "slow_down" });
        expect(await s.pollDeviceAuth(hash(1), NOW + 16_000, 5000)).toEqual({ state: "slow_down" }); // 4 s after the last (slow) poll
        expect(await s.pollDeviceAuth(hash(1), NOW + 21_000, 5000)).toEqual({ state: "pending" });
        expect(await s.pollDeviceAuth(hash(1), NOW + 26_000, 5000)).toEqual({ state: "pending" }); // exactly the interval is fine
        await s.close();
      });

      it("the first poll is never too early, and an approval is delivered even to a fast poller", async () => {
        const s = await make();
        const a = await person(s, "alice");
        await s.createDeviceAuth(dev(1), audit("device.start"));
        expect(await s.pollDeviceAuth(hash(1), NOW, 5000)).toEqual({ state: "pending" });
        await s.decideDeviceAuth(dev(1).userCode, "approve", a.id, NOW + 1, audit("device.approve"));
        expect(await s.pollDeviceAuth(hash(1), NOW + 2, 5000)).toMatchObject({ state: "approved", principalId: a.id });
        await s.close();
      });

      it("polling after expiry (or for a code that never existed) is expired", async () => {
        const s = await make();
        await s.createDeviceAuth(dev(1), audit("device.start"));
        expect(await s.pollDeviceAuth(hash(1), NOW + 599_999, 5000)).toEqual({ state: "pending" });
        expect(await s.pollDeviceAuth(hash(1), NOW + 600_000, 5000)).toEqual({ state: "expired" });
        expect(await s.pollDeviceAuth(hash(9), NOW, 5000)).toEqual({ state: "expired" });
        await s.close();
      });

      it("a later request may reuse the device hash and user code of an expired one", async () => {
        const s = await make();
        await s.createDeviceAuth(dev(1), audit("device.start"));
        const later = { ...dev(1), atMs: NOW + 700_000, expiresAtMs: NOW + 1_300_000 };
        expect(await s.createDeviceAuth(later, audit("device.start"))).toBe(true);
        expect(await s.pollDeviceAuth(hash(1), NOW + 700_001, 5000)).toEqual({ state: "pending" });
        await s.close();
      });

      it("keeps a request whose principal is later disabled readable, so the service can refuse to issue", async () => {
        const s = await make();
        const a = await person(s, "alice");
        await s.createDeviceAuth(dev(1), audit("device.start"));
        await s.decideDeviceAuth(dev(1).userCode, "approve", a.id, NOW + 1, audit("device.approve"));
        await s.disablePrincipal(a.id, NOW + 2, audit("principal.disable", a.id));
        expect(await s.pollDeviceAuth(hash(1), NOW + 6000, 5000)).toMatchObject({ state: "approved", principalId: a.id });
        await s.close();
      });
    });
  });
}
