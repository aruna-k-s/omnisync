import { describe, expect, it } from "vitest";
import { LastAdminError, roleAtLeast, type AuditInput, type CertificateRecord, type IdentityStore, type Principal } from "../src/index.js";

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
  });
}
