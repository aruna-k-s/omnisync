import { afterEach, describe, expect, it } from "vitest";
import { issueCertificate, signerFromKeyPair, verifyEnrollmentProof, decodeCertificate } from "@omnisync/crypto";
import { OmniSyncClient } from "../src/client.js";
import { EnrollmentError, enroll, loginUrl } from "../src/enroll.js";
import { createDeviceKey } from "../src/keys.js";
import { MemoryOutbox } from "../src/outbox.js";
import { World, issuerKey } from "./harness.js";

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

/** A control-plane double that checks the proof exactly as the real service does and signs a real certificate. */
function fakeControlPlane(world: World, principalId: string, calls: { url: string; init?: RequestInit }[] = []) {
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    const auth = (init?.headers as Record<string, string> | undefined)?.["authorization"];
    if (auth !== "Bearer good-session") return new Response(JSON.stringify({ message: "no session" }), { status: 401 });
    if (url.endsWith("/v1/me")) return Response.json({ id: principalId });
    if (url.endsWith("/v1/certificates")) {
      const body = JSON.parse(String(init?.body)) as { publicKey: string; proof: string; lifetimeMs?: number };
      const publicKey = unb64u(body.publicKey);
      if (!verifyEnrollmentProof(principalId, publicKey, unb64u(body.proof))) return new Response(JSON.stringify({ message: "proof of key possession is invalid" }), { status: 400 });
      const now = world.clock.t;
      const serial = globalThis.crypto.getRandomValues(new Uint8Array(16));
      const certificate = issueCertificate({ subject: principalId, subjectPublicKey: publicKey, issuedAtMs: now, notAfterMs: now + (body.lifetimeMs ?? 3_600_000), serial }, signerFromKeyPair(issuerKey));
      return Response.json({ certificate: b64u(certificate), serial: "ab", subject: principalId, notBeforeMs: now, notAfterMs: now + (body.lifetimeMs ?? 3_600_000) });
    }
    return new Response("nope", { status: 404 });
  };
  return fetchFn;
}

describe("enrollment", () => {
  const world = new World();
  afterEach(() => world.cleanup());

  it("sends the login URL, proves possession with the non-extractable key, and receives a certificate the gateway accepts", async () => {
    expect(loginUrl("https://id.example.com/")).toBe("https://id.example.com/v1/auth/login");
    const principal = await world.person("dana");
    const key = await createDeviceKey();
    expect(key.extractable).toBe(false);
    const calls: { url: string; init?: RequestInit }[] = [];
    const result = await enroll({ controlPlaneUrl: "https://id.example.com", sessionToken: "good-session", deviceKey: key, fetch: fakeControlPlane(world, principal.id, calls) });
    expect(calls.map((c) => c.url)).toEqual(["https://id.example.com/v1/me", "https://id.example.com/v1/certificates"]);
    const cert = decodeCertificate(result.certificate);
    expect(cert.subject).toBe(principal.id);
    expect(Array.from(cert.publicKey)).toEqual(Array.from(key.publicKey));
    expect(result.notAfterMs).toBeGreaterThan(result.notBeforeMs);

    // The gateway takes it once the identity store knows it (the real control plane records it before returning).
    await world.identity.recordCertificate(
      { serial: cert.serial, principalId: principal.id, keyId: key.keyId, publicKey: key.publicKey, issuedAtMs: cert.issuedAtMs, notBeforeMs: cert.notBeforeMs, notAfterMs: cert.notAfterMs, certificate: result.certificate },
      { atMs: cert.issuedAtMs, actor: "system", action: "cert.issue", target: principal.id },
    );
    await world.identity.setGrant("doc", principal.id, "write", "system", world.clock.t, { atMs: world.clock.t, actor: "system", action: "grant.set", target: "doc" });
    const { url } = await world.start();
    const client = new OmniSyncClient({ url, key, certificate: result.certificate, outbox: () => new MemoryOutbox() });
    const doc = await client.open("doc");
    await doc.online();
    doc.insertText(0, "enrolled");
    await doc.synced();
    await client.close();
  });

  it("skips the lookup when the principal id is given, and passes the lifetime through", async () => {
    const key = await createDeviceKey();
    const calls: { url: string; init?: RequestInit }[] = [];
    await enroll({ controlPlaneUrl: "https://x", sessionToken: "good-session", principalId: "p1", deviceKey: key, lifetimeMs: 7_200_000, fetch: fakeControlPlane(world, "p1", calls) });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({ lifetimeMs: 7_200_000 });
  });

  it("reports a refusal with its status and reason, and never sends the secret", async () => {
    const key = await createDeviceKey();
    await expect(enroll({ controlPlaneUrl: "https://x", sessionToken: "stale", principalId: "p1", deviceKey: key, fetch: fakeControlPlane(world, "p1") })).rejects.toMatchObject({ name: "EnrollmentError", status: 401 });

    // A proof for another principal is refused by the verifier, which the double mirrors.
    const err = await enroll({ controlPlaneUrl: "https://x", sessionToken: "good-session", principalId: "someone-else", deviceKey: key, fetch: fakeControlPlane(world, "p1") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnrollmentError);
    expect((err as EnrollmentError).status).toBe(400);

    let sent = "";
    await enroll({
      controlPlaneUrl: "https://x",
      sessionToken: "good-session",
      principalId: "p1",
      deviceKey: key,
      fetch: (async (i, init) => {
        sent += String(init?.body ?? "");
        return fakeControlPlane(world, "p1")(i, init);
      }) as typeof fetch,
    });
    expect(sent).not.toContain("secret");
    expect(sent).toContain(b64u(key.publicKey));
  });

  it("rejects an answer it cannot understand", async () => {
    const key = await createDeviceKey();
    const odd: typeof fetch = () => Promise.resolve(Response.json({ certificate: 5 }));
    await expect(enroll({ controlPlaneUrl: "https://x", sessionToken: "t", principalId: "p", deviceKey: key, fetch: odd })).rejects.toThrow(/unexpected/);
  });
});
