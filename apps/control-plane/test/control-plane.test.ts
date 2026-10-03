import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPair } from "@omnisync/protocol";
import { decodeCertificate, signEnrollmentProof, verifyCertificate } from "@omnisync/crypto";
import { signSession } from "../src/session.js";
import { KeyedRateLimiter } from "../src/rate-limit.js";
import { anchors, cookieOf, startPlane, type Plane } from "./helpers.js";

const HOUR = 3_600_000;
const alice = { sub: "alice-sub", email: "alice@example.com", name: "Alice" };
const bob = { sub: "bob-sub", email: "bob@example.com", name: "Bob" };
const root = { sub: "root-sub", email: "root@example.com", name: "Root" };

describe("control plane", () => {
  const planes: Plane[] = [];
  const make = async (...args: Parameters<typeof startPlane>) => {
    const p = await startPlane(...args);
    planes.push(p);
    return p;
  };
  afterEach(async () => {
    await Promise.allSettled(planes.splice(0).map((p) => p.close()));
  });

  describe("login", () => {
    it("completes the OIDC code flow with PKCE and issues a session for a stable principal", async () => {
      const p = await make();
      const a1 = await p.login(alice);
      const a2 = await p.login(alice);
      expect(a1.id).toBe(a2.id); // same OIDC identity, same principal
      expect((await p.login(bob)).id).not.toBe(a1.id);
      const me = await p.call(a1.token, "GET", "/v1/me");
      expect(me.json()).toMatchObject({ id: a1.id, email: "alice@example.com", orgRole: "member" });
      expect((await p.identity.listAudit(0, 50)).some((e) => e.action === "auth.login")).toBe(true);
    });

    it("does not make an unverified email an org admin", async () => {
      const p = await make();
      p.idp.emailVerified = false;
      const r = await p.login(root);
      expect((await p.call(r.token, "GET", "/v1/me")).json()).toMatchObject({ orgRole: "member" });
      p.idp.emailVerified = true;
      const again = await p.login(root);
      expect((await p.call(again.token, "GET", "/v1/me")).json()).toMatchObject({ orgRole: "admin" }); // refreshed at next login
    });

    it("makes configured emails org admins, ignoring case", async () => {
      const p = await make();
      const r = await p.login(root);
      expect((await p.call(r.token, "GET", "/v1/me")).json()).toMatchObject({ orgRole: "admin" });
    });

    it("sends the browser to the IdP with S256 PKCE, state and nonce", async () => {
      const p = await make();
      const res = await p.app.inject({ method: "GET", url: "/v1/auth/login" });
      expect(res.statusCode).toBe(302);
      const u = new URL(res.headers["location"] as string);
      expect(u.origin).toBe(p.idp.issuer);
      expect(u.searchParams.get("code_challenge_method")).toBe("S256");
      for (const k of ["code_challenge", "state", "nonce", "redirect_uri"]) expect(u.searchParams.get(k)).toBeTruthy();
      expect(res.headers["cache-control"]).toBe("no-store");
    });

    it("lets only the browser that started a login finish it (login CSRF)", async () => {
      const p = await make();
      p.idp.user = alice;
      // An attacker starts a login, completes it at the IdP, and tricks a victim into opening the callback URL.
      const attacker = await p.begin();
      const victimNoCookie = await p.app.inject({ method: "GET", url: attacker.callback });
      expect(victimNoCookie.statusCode).toBe(400);
      expect(victimNoCookie.json()).toEqual({ error: "bad_state" });
      // A victim who has some other login cookie fares no better.
      const other = await p.begin();
      const victimWrongCookie = await p.app.inject({ method: "GET", url: attacker.callback, headers: { cookie: other.cookie } });
      expect(victimWrongCookie.statusCode).toBe(400);
      // The failed attempts did not burn the attacker's own pending login, and no token was issued to the victim.
      expect(victimNoCookie.json()).not.toHaveProperty("sessionToken");
      expect((await p.app.inject({ method: "GET", url: attacker.callback, headers: { cookie: attacker.cookie } })).statusCode).toBe(200);
    });

    it("sets a short-lived, HttpOnly, SameSite login cookie, and clears it afterwards", async () => {
      const p = await make();
      const start = await p.app.inject({ method: "GET", url: "/v1/auth/login" });
      const set = String(start.headers["set-cookie"]);
      expect(set).toMatch(/^omnisync_login=[A-Za-z0-9_-]+; Path=\/v1\/auth; Max-Age=600; HttpOnly; SameSite=Lax$/);
      const done = await p.app.inject({
        method: "GET",
        url: await p.idp.browse(start.headers["location"] as string),
        headers: { cookie: cookieOf(start) },
      });
      expect(String(done.headers["set-cookie"])).toMatch(/^omnisync_login=; .*Max-Age=0/);
    });

    it("throttles login starts per client IP and recovers", async () => {
      const p = await make({ loginRateLimit: { burst: 3, perMinute: 6 } });
      const hit = () => p.app.inject({ method: "GET", url: "/v1/auth/login" });
      for (let i = 0; i < 3; i++) expect((await hit()).statusCode).toBe(302);
      const limited = await hit();
      expect(limited.statusCode).toBe(429);
      expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      p.clock.advance(11_000); // 6 per minute: one token every 10 s
      expect((await hit()).statusCode).toBe(302);
    });

    it("accepts each login state once", async () => {
      const p = await make();
      const { callback, cookie } = await p.begin();
      expect((await p.app.inject({ method: "GET", url: callback, headers: { cookie } })).statusCode).toBe(200);
      const replay = await p.app.inject({ method: "GET", url: callback, headers: { cookie } });
      expect(replay.statusCode).toBe(400);
      expect(replay.json()).toEqual({ error: "bad_state" });
    });

    it("rejects unknown, missing and expired state, and IdP error responses", async () => {
      const p = await make();
      expect((await p.app.inject({ method: "GET", url: "/v1/auth/callback?code=x&state=nope" })).statusCode).toBe(400);
      expect((await p.app.inject({ method: "GET", url: "/v1/auth/callback?code=x" })).statusCode).toBe(400);
      expect((await p.app.inject({ method: "GET", url: "/v1/auth/callback?error=access_denied" })).statusCode).toBe(400);

      const { callback, cookie } = await p.begin();
      p.clock.advance(11 * 60_000);
      expect((await p.app.inject({ method: "GET", url: callback, headers: { cookie } })).statusCode).toBe(400);
      expect(p.idp.tokenRequests).toBe(0); // never reached the IdP
    });

    it("rejects an ID token with the wrong nonce, audience or issuer", async () => {
      for (const tamper of [{ nonce: "other" }, { audience: "someone-else" }, { issuer: "http://evil.example" }]) {
        const p = await make();
        p.idp.tamper = tamper;
        const { callback, cookie } = await p.begin();
        const res = await p.app.inject({ method: "GET", url: callback, headers: { cookie } });
        expect(res.statusCode, JSON.stringify(tamper)).toBe(400);
        expect(res.json()).toEqual({ error: "token_rejected" });
      }
    });

    it("answers 502 when the IdP cannot be reached", async () => {
      const p = await make();
      await p.idp.stop();
      const res = await p.app.inject({ method: "GET", url: "/v1/auth/login" });
      expect(res.statusCode).toBe(502);
    });

  });

  describe("sessions", () => {
    it("require a valid, unexpired token for a live account", async () => {
      const p = await make();
      const a = await p.login(alice);
      expect((await p.call(undefined, "GET", "/v1/me")).statusCode).toBe(401);
      expect((await p.call("garbage", "GET", "/v1/me")).statusCode).toBe(401);
      const wrongKey = await signSession(new Uint8Array(32).fill(1), a.id, p.clock.t, HOUR);
      expect((await p.call(wrongKey, "GET", "/v1/me")).statusCode).toBe(401);
      const ghost = await signSession(new Uint8Array(32).fill(9), "p_ghost", p.clock.t, HOUR);
      expect((await p.call(ghost, "GET", "/v1/me")).statusCode).toBe(401);
      p.clock.advance(HOUR + 1000);
      expect((await p.call(a.token, "GET", "/v1/me")).statusCode).toBe(401);
    });
  });

  describe("certificates", () => {
    it("issues a certificate the gateway's trust anchor accepts, recorded and audited", async () => {
      const p = await make();
      const a = await p.login(alice);
      const { key, res } = await p.enroll(a.token, a.id);
      expect(res.statusCode).toBe(201);
      const body = res.json<{ certificate: string; serial: string; subject: string; notAfterMs: number }>();
      const bytes = new Uint8Array(Buffer.from(body.certificate, "base64url"));
      const v = verifyCertificate(bytes, anchors);
      expect(v.ok).toBe(true);
      if (!v.ok) return;
      expect(v.certificate.subject).toBe(a.id);
      expect(Buffer.from(v.certificate.publicKey).equals(Buffer.from(key.publicKey))).toBe(true);
      expect(v.certificate.notAfterMs - v.certificate.notBeforeMs).toBe(24 * HOUR);
      expect(body.serial).toBe(Buffer.from(v.certificate.serial).toString("hex"));
      const rec = await p.identity.getCertificate(v.certificate.serial);
      expect(rec).toMatchObject({ principalId: a.id });
      const audit = await p.identity.listAudit(0, 50);
      expect(audit.find((e) => e.action === "cert.issue")).toMatchObject({ actor: a.id, target: body.serial });
    });

    it("clamps the lifetime to the configured maximum and refuses absurdly short ones", async () => {
      const p = await make({ certMaxLifetimeMs: 48 * HOUR });
      const a = await p.login(alice);
      const long = await p.enroll(a.token, a.id, undefined, 1000 * HOUR);
      const c = decodeCertificate(new Uint8Array(Buffer.from(long.res.json<{ certificate: string }>().certificate, "base64url")));
      expect(c.notAfterMs - c.notBeforeMs).toBe(48 * HOUR);
      expect((await p.enroll(a.token, a.id, undefined, 1000)).res.statusCode).toBe(400);
    });

    it("refuses a key the requester cannot prove they hold", async () => {
      const p = await make();
      const a = await p.login(alice);
      const mine = generateKeyPair(new Uint8Array(32).fill(70));
      const victim = generateKeyPair(new Uint8Array(32).fill(71));
      const post = (publicKey: Uint8Array, proof: Uint8Array) =>
        p.call(a.token, "POST", "/v1/certificates", {
          publicKey: Buffer.from(publicKey).toString("base64url"),
          proof: Buffer.from(proof).toString("base64url"),
        });
      // Alice's proof over Bob's public key, signed with her own key.
      expect((await post(victim.publicKey, signEnrollmentProof(a.id, victim.publicKey, mine.secretKey))).statusCode).toBe(400);
      // A proof made for another principal.
      expect((await post(mine.publicKey, signEnrollmentProof("p_other", mine.publicKey, mine.secretKey))).statusCode).toBe(400);
      expect((await post(mine.publicKey, signEnrollmentProof(a.id, mine.publicKey, mine.secretKey))).statusCode).toBe(201);
    });

    it("validates request bodies", async () => {
      const p = await make();
      const a = await p.login(alice);
      for (const body of [{}, { publicKey: "!!", proof: "x" }, { publicKey: "AAAA", proof: "AAAA" }, { publicKey: 5, proof: 5 }]) {
        expect((await p.call(a.token, "POST", "/v1/certificates", body)).statusCode).toBe(400);
      }
      expect((await p.call(undefined, "POST", "/v1/certificates", {})).statusCode).toBe(401);
      const big = await p.call(a.token, "POST", "/v1/certificates", { publicKey: "A".repeat(20_000) });
      expect(big.statusCode).toBe(413);
    });

    it("lets owners revoke their own certificates, admins anyone's, and nobody twice", async () => {
      const p = await make();
      const a = await p.login(alice);
      const b = await p.login(bob);
      const r = await p.login(root);
      const ca = (await p.enroll(a.token, a.id)).res.json<{ serial: string }>().serial;
      const cb = (await p.enroll(b.token, b.id)).res.json<{ serial: string }>().serial;

      expect((await p.call(b.token, "POST", `/v1/certificates/${ca}/revoke`, {})).statusCode).toBe(403);
      expect((await p.call(a.token, "POST", `/v1/certificates/${ca}/revoke`, { reason: "lost laptop" })).statusCode).toBe(200);
      expect((await p.call(a.token, "POST", `/v1/certificates/${ca}/revoke`, {})).statusCode).toBe(409);
      expect((await p.call(r.token, "POST", `/v1/certificates/${cb}/revoke`, {})).statusCode).toBe(200);
      expect((await p.call(a.token, "POST", "/v1/certificates/not-hex/revoke", {})).statusCode).toBe(400);
      expect((await p.call(a.token, "POST", `/v1/certificates/${"0".repeat(32)}/revoke`, {})).statusCode).toBe(404);

      const rec = await p.identity.getCertificate(new Uint8Array(Buffer.from(ca, "hex")));
      expect(rec).toMatchObject({ revokeReason: "lost laptop" });
    });
  });

  describe("accounts", () => {
    it("lets only org admins disable a person, revoking their certificates and ending their sessions", async () => {
      const p = await make();
      const a = await p.login(alice);
      const b = await p.login(bob);
      const r = await p.login(root);
      await p.enroll(b.token, b.id);
      await p.enroll(b.token, b.id);

      expect((await p.call(a.token, "POST", `/v1/principals/${b.id}/disable`)).statusCode).toBe(403);
      expect((await p.call(r.token, "POST", `/v1/principals/${r.id}/disable`)).statusCode).toBe(400);
      expect((await p.call(r.token, "POST", "/v1/principals/p_nobody/disable")).statusCode).toBe(404);
      const res = await p.call(r.token, "POST", `/v1/principals/${b.id}/disable`);
      expect(res.json()).toEqual({ certificatesRevoked: 2 });

      expect((await p.call(b.token, "GET", "/v1/me")).statusCode).toBe(401); // existing session dies at once
      p.idp.user = bob;
      const { callback, cookie } = await p.begin();
      expect((await p.app.inject({ method: "GET", url: callback, headers: { cookie } })).statusCode).toBe(403); // cannot log in again
    });
  });

  describe("documents and access lists", () => {
    it("makes the creator admin and lets admins manage grants, with every change audited", async () => {
      const p = await make();
      const a = await p.login(alice);
      const b = await p.login(bob);
      const { id } = (await p.call(a.token, "POST", "/v1/documents")).json<{ id: string }>();
      expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);

      const list = (await p.call(a.token, "GET", `/v1/documents/${id}/grants`)).json<{ grants: { principalId: string; role: string }[] }>();
      expect(list.grants).toMatchObject([{ principalId: a.id, role: "admin" }]);

      expect((await p.call(a.token, "PUT", `/v1/documents/${id}/grants/${b.id}`, { role: "write" })).statusCode).toBe(200);
      expect(await p.identity.roleOf(id, b.id)).toBe("write");
      expect((await p.call(a.token, "PUT", `/v1/documents/${id}/grants/${b.id}`, { role: "owner" })).statusCode).toBe(400);
      expect((await p.call(a.token, "PUT", `/v1/documents/${id}/grants/p_ghost`, { role: "read" })).statusCode).toBe(404);
      expect((await p.call(a.token, "DELETE", `/v1/documents/${id}/grants/${b.id}`)).statusCode).toBe(200);
      expect((await p.call(a.token, "DELETE", `/v1/documents/${id}/grants/${b.id}`)).statusCode).toBe(404);

      const actions = (await p.identity.listAudit(0, 100)).map((e) => e.action);
      expect(actions).toEqual(expect.arrayContaining(["document.create", "grant.set", "grant.remove"]));
    });

    it("hides documents from people who are not admins of them", async () => {
      const p = await make();
      const a = await p.login(alice);
      const b = await p.login(bob);
      const { id } = (await p.call(a.token, "POST", "/v1/documents")).json<{ id: string }>();
      await p.call(a.token, "PUT", `/v1/documents/${id}/grants/${b.id}`, { role: "write" });
      // Bob can edit but may not manage access; strangers and writers get the same answer as for a missing document.
      expect((await p.call(b.token, "GET", `/v1/documents/${id}/grants`)).statusCode).toBe(404);
      expect((await p.call(b.token, "PUT", `/v1/documents/${id}/grants/${b.id}`, { role: "admin" })).statusCode).toBe(404);
      expect((await p.call(b.token, "GET", "/v1/documents/does-not-exist/grants")).statusCode).toBe(404);
      expect((await p.call(b.token, "GET", "/v1/documents/bad%20id/grants")).statusCode).toBe(400);
    });

    it("never lets a document lose its last admin", async () => {
      const p = await make();
      const a = await p.login(alice);
      const b = await p.login(bob);
      const { id } = (await p.call(a.token, "POST", "/v1/documents")).json<{ id: string }>();
      expect((await p.call(a.token, "PUT", `/v1/documents/${id}/grants/${a.id}`, { role: "read" })).statusCode).toBe(409);
      expect((await p.call(a.token, "DELETE", `/v1/documents/${id}/grants/${a.id}`)).statusCode).toBe(409);
      await p.call(a.token, "PUT", `/v1/documents/${id}/grants/${b.id}`, { role: "admin" });
      expect((await p.call(a.token, "PUT", `/v1/documents/${id}/grants/${a.id}`, { role: "read" })).statusCode).toBe(200);
      expect((await p.call(b.token, "DELETE", `/v1/documents/${id}/grants/${b.id}`)).statusCode).toBe(409);
    });
  });

  describe("failure modes", () => {
    it("answers 503 and changes nothing when storage is down", async () => {
      const p = await make();
      const a = await p.login(alice);
      p.identity.down = true;
      expect((await p.call(a.token, "POST", "/v1/documents")).statusCode).toBe(503); // even the session check needs the store
      expect((await p.call(a.token, "POST", "/v1/documents")).json()).toEqual({ error: "storage unavailable" });
      p.identity.down = false;
      const { id } = (await p.call(a.token, "POST", "/v1/documents")).json<{ id: string }>();
      expect(id).toBeTruthy();
    });

    it("reports liveness without touching storage", async () => {
      const p = await make();
      p.identity.down = true;
      expect((await p.app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ ok: true });
    });

    it("rejects weak session secrets at startup", async () => {
      await expect(make({ sessionSecret: new Uint8Array(8) })).rejects.toThrow(/sessionSecret/);
    });
  });
});


describe("KeyedRateLimiter", () => {
  it("refills over time and never tracks more than its bound", () => {
    let t = 0;
    const l = new KeyedRateLimiter(2, 60, () => t, 3);
    expect([l.take("a"), l.take("a")]).toEqual([0, 0]);
    expect(l.take("a")).toBeGreaterThan(0);
    t += 1000; // one token per second
    expect(l.take("a")).toBe(0);
    t -= 5000; // clock steps back: no negative refill
    expect(l.take("a")).toBeGreaterThan(0);
    for (const k of ["b", "c", "d", "e"]) l.take(k);
    expect(l.size).toBe(3);
  });
});
