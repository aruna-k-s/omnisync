import { afterEach, describe, expect, it } from "vitest";
import { IdentityService } from "../src/service.js";
import { resolveConfig } from "../src/config.js";
import { issuerKey } from "./helpers.js";
import { signerFromKeyPair } from "@omnisync/crypto";
import { startPlane, T0, type Plane } from "./helpers.js";

const alice = { sub: "alice-sub", email: "alice@example.com", name: "Alice" };
const bob = { sub: "bob-sub", email: "bob@example.com", name: "Bob" };
const root = { sub: "root-sub", email: "root@example.com", name: "Root" };
const MISSING_DOC = "0b6f0f0e-7d2c-4c5e-9b0a-1f2e3d4c5b6a";
const audit = (action: string) => ({ atMs: T0, actor: "system", action, target: "" });

describe("admin API", () => {
  const planes: Plane[] = [];
  const make = async (...args: Parameters<typeof startPlane>) => {
    const p = await startPlane(...args);
    planes.push(p);
    return p;
  };
  afterEach(async () => {
    await Promise.allSettled(planes.splice(0).map((p) => p.close()));
  });

  /** A plane with an org admin (root), a member (alice) who owns a document, and bob. */
  async function world(over: Parameters<typeof startPlane>[0] = {}) {
    const p = await make(over);
    const r = await p.login(root);
    const a = await p.login(alice);
    const b = await p.login(bob);
    const doc = (await p.call(a.token, "POST", "/v1/documents")).json<{ id: string }>().id;
    return { p, r, a, b, doc };
  }

  describe("access", () => {
    it("refuses everything without a session (401) and to members (403), and serves org admins", async () => {
      const { p, r, a, b, doc } = await world({ ledger: ledger() });
      const routes: [string, string, unknown?][] = [
        ["GET", "/v1/admin/principals"],
        ["GET", `/v1/admin/principals/${a.id}/certificates`],
        ["GET", "/v1/admin/documents"],
        ["GET", `/v1/admin/documents/${doc}/grants`],
        ["PUT", `/v1/admin/documents/${doc}/grants/${b.id}`, { role: "read" }],
        ["DELETE", `/v1/admin/documents/${doc}/grants/${b.id}`],
        ["GET", "/v1/admin/audit"],
        ["GET", "/v1/admin/ledger/trust"],
        ["GET", "/v1/admin/ledger/export"],
      ];
      for (const [method, url, body] of routes) {
        const m = method as "GET" | "PUT" | "DELETE";
        expect((await p.call(undefined, m, url, body)).statusCode, `${method} ${url} anonymous`).toBe(401);
        const asMember = await p.call(a.token, m, url, body);
        expect(asMember.statusCode, `${method} ${url} member`).toBe(403);
        expect(asMember.json()).toEqual({ error: "organisation admin only" });
      }
      // The admin gets through (PUT first so DELETE has something to remove).
      for (const [method, url, body] of routes) {
        const res = await p.call(r.token, method as "GET" | "PUT" | "DELETE", url, body);
        expect(res.statusCode, `${method} ${url} admin: ${res.body.slice(0, 100)}`).toBe(200);
      }
    });

    it("re-reads the role on every request: a demoted or disabled admin is cut off at once", async () => {
      const { p, r } = await world();
      expect((await p.call(r.token, "GET", "/v1/admin/principals")).statusCode).toBe(200);
      const me = (await p.call(r.token, "GET", "/v1/me")).json<{ id: string }>();
      await p.identity.upsertPrincipal({ oidcIssuer: p.idp.issuer, oidcSubject: root.sub, email: root.email, displayName: "Root", orgRole: "member" }, audit("auth.login"));
      expect((await p.call(r.token, "GET", "/v1/admin/principals")).statusCode).toBe(403);
      await p.identity.upsertPrincipal({ oidcIssuer: p.idp.issuer, oidcSubject: root.sub, email: root.email, displayName: "Root", orgRole: "admin" }, audit("auth.login"));
      expect((await p.call(r.token, "GET", "/v1/admin/principals")).statusCode).toBe(200);
      await p.identity.disablePrincipal(me.id, T0, audit("principal.disable"));
      expect((await p.call(r.token, "GET", "/v1/admin/principals")).statusCode).toBe(401);
    });

    it("answers 503 when storage is down", async () => {
      const { p, r } = await world();
      p.identity.down = true;
      // The session guard reads the principal first, so even the guard cannot pass.
      expect((await p.call(r.token, "GET", "/v1/admin/principals")).statusCode).toBe(503);
    });
  });

  describe("listings", () => {
    it("pages principals and documents with next until the last page, without gaps or repeats", async () => {
      const { p, r } = await world();
      for (let i = 0; i < 4; i++) await p.login({ sub: `extra${i}`, email: `extra${i}@example.com`, name: `E${i}` });
      for (let i = 0; i < 3; i++) await p.call((await p.login(alice)).token, "POST", "/v1/documents");

      const seen: string[] = [];
      let after: string | undefined;
      let pages = 0;
      do {
        const res = await p.call(r.token, "GET", `/v1/admin/principals?limit=3${after ? `&after=${encodeURIComponent(after)}` : ""}`);
        const body = res.json<{ principals: { id: string; email: string; orgRole: string }[]; next?: string }>();
        expect(body.principals.length).toBeLessThanOrEqual(3);
        seen.push(...body.principals.map((x) => x.id));
        after = body.next;
        pages++;
      } while (after);
      expect(seen).toHaveLength(7); // root, alice, bob, 4 extras
      expect(new Set(seen).size).toBe(7);
      expect([...seen].sort()).toEqual(seen);
      expect(pages).toBe(3);

      const docs: string[] = [];
      for (let a: string | undefined; ; ) {
        const body = (await p.call(r.token, "GET", `/v1/admin/documents?limit=2${a ? `&after=${a}` : ""}`)).json<{ documents: { id: string; createdBy: string }[]; next?: string }>();
        docs.push(...body.documents.map((d) => d.id));
        if (!body.next) break;
        a = body.next;
      }
      expect(docs).toHaveLength(4);
      const first = (await p.call(r.token, "GET", "/v1/admin/documents")).json<{ documents: unknown[]; next?: string }>();
      expect(first.documents).toHaveLength(4);
      expect(first.next).toBeUndefined(); // a page that is not full has no next
    });

    it("defaults to 100 per page and refuses a repeated parameter", async () => {
      const { p, r } = await world();
      for (let i = 0; i < 105; i++) {
        await p.identity.upsertPrincipal({ oidcIssuer: "https://idp.example", oidcSubject: `bulk${i}`, email: `b${i}@example.com`, displayName: `B${i}`, orgRole: "member" }, audit("auth.login"));
      }
      const body = (await p.call(r.token, "GET", "/v1/admin/principals")).json<{ principals: { id: string }[]; next?: string }>();
      expect(body.principals).toHaveLength(100);
      expect(body.next).toBe(body.principals[99]?.id);
      for (const path of ["principals", "documents", "audit"]) {
        expect((await p.call(r.token, "GET", `/v1/admin/${path}?limit=1&limit=2`)).statusCode, path).toBe(400);
      }
      expect((await p.call(r.token, "GET", "/v1/admin/principals?after=a&after=b")).statusCode).toBe(400);
    });

    it("shows disabled principals, and rejects bad paging parameters with 400", async () => {
      const { p, r, b } = await world();
      await p.call(r.token, "POST", `/v1/principals/${b.id}/disable`);
      const list = (await p.call(r.token, "GET", "/v1/admin/principals")).json<{ principals: { id: string; disabledAtMs?: number }[] }>();
      expect(list.principals.find((x) => x.id === b.id)?.disabledAtMs).toBe(T0);
      expect(list.principals.find((x) => x.id !== b.id)?.disabledAtMs).toBeUndefined();
      for (const q of ["limit=0", "limit=501", "limit=abc", "limit=1.5", "limit=-1", "after=" + "x".repeat(200), "after=a%20b"]) {
        expect((await p.call(r.token, "GET", `/v1/admin/principals?${q}`)).statusCode, q).toBe(400);
        expect((await p.call(r.token, "GET", `/v1/admin/documents?${q}`)).statusCode, q).toBe(400);
      }
      for (const q of ["after=-1", "after=abc", "after=1.5", "limit=0"]) expect((await p.call(r.token, "GET", `/v1/admin/audit?${q}`)).statusCode, q).toBe(400);
      expect((await p.call(r.token, "GET", "/v1/admin/principals?limit=500")).statusCode).toBe(200);
    });

    it("lists a principal's certificates with revocation state and no key material", async () => {
      const { p, r, a } = await world();
      const first = await p.enroll(a.token, a.id);
      p.clock.advance(1000);
      const second = await p.enroll(a.token, a.id);
      const serial1 = first.res.json<{ serial: string }>().serial;
      const serial2 = second.res.json<{ serial: string }>().serial;

      const body = (await p.call(r.token, "GET", `/v1/admin/principals/${a.id}/certificates`)).json<{ certificates: Record<string, unknown>[] }>();
      expect(body.certificates.map((c) => c["serial"])).toEqual([serial2, serial1]); // newest first
      expect(body.certificates[0]).toMatchObject({ serial: serial2, notBeforeMs: T0 + 1000 });
      expect(body.certificates[0]?.["revokedAtMs"]).toBeUndefined();
      for (const c of body.certificates) {
        expect(Object.keys(c).sort()).toEqual(["issuedAtMs", "keyId", "notAfterMs", "notBeforeMs", "serial"]);
        expect(c["keyId"]).toMatch(/^[0-9a-f]{16}$/);
      }

      // One-click revoke is the existing route; the listing reflects it.
      p.clock.advance(5);
      expect((await p.call(r.token, "POST", `/v1/certificates/${serial1}/revoke`, { reason: "lost laptop" })).statusCode).toBe(200);
      const after = (await p.call(r.token, "GET", `/v1/admin/principals/${a.id}/certificates`)).json<{ certificates: { serial: string; revokedAtMs?: number; revokeReason?: string }[] }>();
      expect(after.certificates.find((c) => c.serial === serial1)).toMatchObject({ revokedAtMs: T0 + 1005, revokeReason: "lost laptop" });
      expect(after.certificates.find((c) => c.serial === serial2)?.revokedAtMs).toBeUndefined();

      expect((await p.call(r.token, "GET", `/v1/admin/principals/ghost/certificates`)).statusCode).toBe(404);
      expect((await p.call(r.token, "GET", `/v1/admin/principals/${encodeURIComponent("a b")}/certificates`)).statusCode).toBe(400);
    });

    it("lists audit events oldest first and pages with after", async () => {
      const { p, r } = await world();
      const all = (await p.call(r.token, "GET", "/v1/admin/audit?limit=500")).json<{ events: { id: number; action: string; atMs: number }[]; next?: string }>();
      expect(all.events.length).toBeGreaterThanOrEqual(4);
      expect(all.events.map((e) => e.id)).toEqual([...all.events.map((e) => e.id)].sort((x, y) => x - y));
      expect(all.events.some((e) => e.action === "document.create")).toBe(true);
      const page = (await p.call(r.token, "GET", "/v1/admin/audit?limit=2")).json<{ events: { id: number }[]; next?: string }>();
      expect(page.events.map((e) => e.id)).toEqual(all.events.slice(0, 2).map((e) => e.id));
      expect(page.next).toBe(String(page.events[1]?.id));
      const rest = (await p.call(r.token, "GET", `/v1/admin/audit?after=${page.next}&limit=500`)).json<{ events: { id: number }[] }>();
      expect(rest.events.map((e) => e.id)).toEqual(all.events.slice(2).map((e) => e.id));
    });
  });

  describe("grants on any document", () => {
    it("lets an org admin with no grant set, change and remove grants, each audited with their id", async () => {
      const { p, r, a, b, doc } = await world();
      expect((await p.call(r.token, "GET", `/v1/documents/${doc}/grants`)).statusCode).toBe(404); // the document-level route still hides it
      expect((await p.call(r.token, "PUT", `/v1/admin/documents/${doc}/grants/${b.id}`, { role: "read" })).statusCode).toBe(200);
      expect((await p.call(r.token, "PUT", `/v1/admin/documents/${doc}/grants/${b.id}`, { role: "merge" })).statusCode).toBe(200);
      const grants = (await p.call(r.token, "GET", `/v1/admin/documents/${doc}/grants`)).json<{ grants: { principalId: string; role: string; grantedBy: string }[] }>().grants;
      expect(grants.find((g) => g.principalId === b.id)).toMatchObject({ role: "merge", grantedBy: r.id });
      expect(grants.find((g) => g.principalId === a.id)?.role).toBe("admin");
      expect((await p.call(r.token, "DELETE", `/v1/admin/documents/${doc}/grants/${b.id}`)).statusCode).toBe(200);
      expect((await p.call(r.token, "DELETE", `/v1/admin/documents/${doc}/grants/${b.id}`)).statusCode).toBe(404);

      const events = (await p.identity.listAudit(0, 500)).filter((e) => e.actor === r.id && e.action.startsWith("grant."));
      expect(events.map((e) => [e.action, e.target, e.detail])).toEqual([
        ["grant.set", `${doc}:${b.id}`, "read"],
        ["grant.set", `${doc}:${b.id}`, "merge"],
        ["grant.remove", `${doc}:${b.id}`, ""],
      ]);
    });

    it("keeps the last-admin guard (409) and validates input", async () => {
      const { p, r, a, b, doc } = await world();
      expect((await p.call(r.token, "DELETE", `/v1/admin/documents/${doc}/grants/${a.id}`)).statusCode).toBe(409);
      expect((await p.call(r.token, "PUT", `/v1/admin/documents/${doc}/grants/${a.id}`, { role: "read" })).statusCode).toBe(409);
      expect((await p.call(r.token, "PUT", `/v1/admin/documents/${doc}/grants/${b.id}`, { role: "owner" })).statusCode).toBe(400);
      expect((await p.call(r.token, "PUT", `/v1/admin/documents/${doc}/grants/${b.id}`, {})).statusCode).toBe(400);
      expect((await p.call(r.token, "PUT", `/v1/admin/documents/${doc}/grants/ghost`, { role: "read" })).statusCode).toBe(404);
      expect((await p.call(r.token, "PUT", `/v1/admin/documents/${MISSING_DOC}/grants/${b.id}`, { role: "read" })).statusCode).toBe(404);
      expect((await p.call(r.token, "GET", `/v1/admin/documents/${MISSING_DOC}/grants`)).statusCode).toBe(404);
      expect((await p.call(r.token, "DELETE", `/v1/admin/documents/${MISSING_DOC}/grants/${b.id}`)).statusCode).toBe(404);
      for (const bad of ["nope", "0B6F0F0E-7D2C-4C5E-9B0A-1F2E3D4C5B6A", "0b6f0f0e-7d2c-1c5e-9b0a-1f2e3d4c5b6a"]) {
        expect((await p.call(r.token, "GET", `/v1/admin/documents/${bad}/grants`)).statusCode, bad).toBe(400);
        expect((await p.call(r.token, "PUT", `/v1/admin/documents/${bad}/grants/${b.id}`, { role: "read" })).statusCode, bad).toBe(400);
        expect((await p.call(r.token, "DELETE", `/v1/admin/documents/${bad}/grants/${b.id}`)).statusCode, bad).toBe(400);
      }
      // Nothing above changed access.
      const grants = (await p.call(r.token, "GET", `/v1/admin/documents/${doc}/grants`)).json<{ grants: unknown[] }>().grants;
      expect(grants).toHaveLength(1);
    });
  });

  describe("service rules hold without the HTTP guard", () => {
    it("refuses org-level grant changes and export audits for a member", async () => {
      const { p, a, b, doc } = await world();
      const svc = p.app.get(IdentityService);
      const member = await p.identity.getPrincipal(a.id);
      expect(member?.orgRole).toBe("member");
      await expect(svc.setGrant(member as never, doc, b.id, "read", true)).rejects.toMatchObject({ code: "forbidden" });
      await expect(svc.removeGrant(member as never, doc, a.id, true)).rejects.toMatchObject({ code: "forbidden" });
      await expect(svc.listGrants(member as never, doc, true)).rejects.toMatchObject({ code: "forbidden" });
      await expect(svc.auditLedgerExport(member as never, "acme")).rejects.toMatchObject({ code: "forbidden" });
      expect((await p.identity.listAudit(0, 1000)).some((e) => e.action === "ledger.export")).toBe(false);
    });
  });

  describe("ledger", () => {
    it("serves the injected export as NDJSON, with the audit event written before the first byte", async () => {
      const seen: { auditBefore?: boolean } = {};
      const holder: { plane?: Plane } = {};
      const { p, r } = await world({
        ledger: ledger({
          async export(write) {
            seen.auditBefore = ((await holder.plane?.identity.listAudit(0, 1000)) ?? []).some((e) => e.action === "ledger.export");
            await write('{"t":"meta"}\n');
            await write('{"t":"entry"}\n');
          },
        }),
      });
      holder.plane = p;
      const res = await p.call(r.token, "GET", "/v1/admin/ledger/export");
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('{"t":"meta"}\n{"t":"entry"}\n');
      expect(res.headers["content-type"]).toContain("application/x-ndjson");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["content-disposition"]).toBe('attachment; filename="acme-ledger.ndjson"');
      expect(seen.auditBefore).toBe(true);
      const ev = (await p.identity.listAudit(0, 1000)).filter((e) => e.action === "ledger.export");
      expect(ev).toEqual([expect.objectContaining({ actor: r.id, target: "acme" })]);
    });

    it("refuses an export over the cap with 413 and sends nothing, but still audits it", async () => {
      const { p, r } = await world({ ledger: ledger({ maxExportBytes: 20, export: async (w) => { await w("x".repeat(15) + "\n"); await w("y".repeat(15) + "\n"); } }) });
      const res = await p.call(r.token, "GET", "/v1/admin/ledger/export");
      expect(res.statusCode).toBe(413);
      expect(res.json()).toEqual({ error: "export too large; use the export command" });
      expect(res.body).not.toContain("xxxx");
      expect((await p.identity.listAudit(0, 1000)).filter((e) => e.action === "ledger.export")).toHaveLength(1);
      // Exactly at the cap is allowed.
      const exact = await world({ ledger: ledger({ maxExportBytes: 16, export: async (w) => { await w("z".repeat(15) + "\n"); } }) });
      expect((await exact.p.call(exact.r.token, "GET", "/v1/admin/ledger/export")).statusCode).toBe(200);
    });

    it("counts the cap in bytes, not characters", async () => {
      const { p, r } = await world({ ledger: ledger({ maxExportBytes: 12, export: async (w) => { await w("é".repeat(8) + "\n"); } }) }); // 9 characters, 17 bytes
      expect((await p.call(r.token, "GET", "/v1/admin/ledger/export")).statusCode).toBe(413);
    });

    it("defaults the cap to 64 MiB", () => {
      const cfg = resolveConfig({
        oidc: { issuerUrl: "https://idp.example", clientId: "c", redirectUri: "https://cp.example/v1/auth/callback" },
        issuer: signerFromKeyPair(issuerKey),
        sessionSecret: new Uint8Array(32).fill(1),
        ledger: ledger(),
      });
      expect(cfg.ledger?.maxExportBytes).toBe(64 * 1024 * 1024);
    });

    it("runs one export at a time (429 + retry-after) and frees the slot after success or failure", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((res) => (release = res));
      let started: () => void = () => {};
      const running = new Promise<void>((res) => (started = res));
      let calls = 0;
      const { p, r } = await world({
        ledger: ledger({
          async export(write) {
            calls++;
            if (calls === 1) {
              started();
              await gate;
            }
            if (calls === 3) throw new Error("db exploded: secret-detail");
            await write("{}\n");
          },
        }),
      });
      const first = p.call(r.token, "GET", "/v1/admin/ledger/export");
      await running;
      const second = await p.call(r.token, "GET", "/v1/admin/ledger/export");
      expect(second.statusCode).toBe(429);
      expect(Number(second.headers["retry-after"])).toBeGreaterThan(0);
      release();
      expect((await first).statusCode).toBe(200);
      expect((await p.call(r.token, "GET", "/v1/admin/ledger/export")).statusCode).toBe(200); // slot freed
      const failed = await p.call(r.token, "GET", "/v1/admin/ledger/export");
      expect(failed.statusCode).toBe(500);
      expect(failed.body).not.toContain("secret-detail");
      expect(calls).toBe(3);
      expect((await p.call(r.token, "GET", "/v1/admin/ledger/export")).statusCode).toBe(200); // and after a failure
      expect((await p.identity.listAudit(0, 1000)).filter((e) => e.action === "ledger.export")).toHaveLength(4); // the 429 did not count
    });

    it("refuses to export when the audit event cannot be written", async () => {
      let ran = false;
      const { p, r } = await world({ ledger: ledger({ export: async () => { ran = true; } }) });
      p.identity.appendAuditFails = true;
      const res = await p.call(r.token, "GET", "/v1/admin/ledger/export");
      expect(res.statusCode).toBe(503);
      expect(ran).toBe(false);
      p.identity.appendAuditFails = false;
      expect((await p.call(r.token, "GET", "/v1/admin/ledger/export")).statusCode).toBe(200);
    });

    it("is 404 when no ledger is configured, and trust lists exactly the configured keys with anchored false", async () => {
      const bare = await world();
      for (const u of ["/v1/admin/ledger/trust", "/v1/admin/ledger/export"]) {
        const res = await bare.p.call(bare.r.token, "GET", u);
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: "ledger not configured" });
      }
      const { p, r } = await world({ ledger: ledger() });
      expect((await p.call(r.token, "GET", "/v1/admin/ledger/trust")).json()).toEqual({
        tenant: "acme",
        issuers: ["11".repeat(32)],
        ledgerKeys: ["22".repeat(32), "33".repeat(32)],
        anchored: false,
      });
    });

    it("sanitises the tenant in the download name", async () => {
      const { p, r } = await world({ ledger: ledger({ tenant: 'ac"me\r\nx', export: async (w) => { await w("{}\n"); } }) });
      expect((await p.call(r.token, "GET", "/v1/admin/ledger/export")).headers["content-disposition"]).toBe('attachment; filename="ledger.ndjson"');
    });
  });
});

function ledger(over: Partial<{ tenant: string; maxExportBytes: number; export: (write: (l: string) => Promise<void>) => Promise<unknown> }> = {}) {
  return {
    tenant: over.tenant ?? "acme",
    issuers: [new Uint8Array(32).fill(0x11)],
    ledgerKeys: [new Uint8Array(32).fill(0x22), new Uint8Array(32).fill(0x33)],
    export: over.export ?? (async (write: (l: string) => Promise<void>) => { await write("{}\n"); }),
    ...(over.maxExportBytes !== undefined ? { maxExportBytes: over.maxExportBytes } : {}),
  };
}
