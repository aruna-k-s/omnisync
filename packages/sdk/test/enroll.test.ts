import { afterEach, describe, expect, it } from "vitest";
import { decodeCertificate } from "@omnisync/crypto";
import { OmniSyncClient } from "../src/client.js";
import { EnrollmentError, enroll, loginUrl } from "../src/enroll.js";
import { createDeviceKey } from "../src/keys.js";
import { MemoryOutbox } from "../src/outbox.js";
import { World, fakeControlPlane } from "./harness.js";

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");

describe("enrollment", () => {
  const world = new World();
  afterEach(() => world.cleanup());

  it("sends the login URL, proves possession with the non-extractable key, and receives a certificate the gateway accepts", async () => {
    expect(loginUrl("https://id.example.com/")).toBe("https://id.example.com/v1/auth/login");
    const principal = await world.person("dana");
    const key = await createDeviceKey();
    expect(key.extractable).toBe(false);
    const calls: { url: string; init?: RequestInit }[] = [];
    const result = await enroll({ controlPlaneUrl: "https://id.example.com", sessionToken: "good-session", deviceKey: key, fetch: fakeControlPlane(world, principal.id, { calls, grants: { doc: "write" } }) });
    expect(calls.map((c) => c.url)).toEqual(["https://id.example.com/v1/me", "https://id.example.com/v1/certificates"]);
    const cert = decodeCertificate(result.certificate);
    expect(cert.subject).toBe(principal.id);
    expect(Array.from(cert.publicKey)).toEqual(Array.from(key.publicKey));
    expect(result.notAfterMs).toBeGreaterThan(result.notBeforeMs);

    // The double recorded it, as the real control plane does before answering, so the gateway takes it.
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
    await enroll({ controlPlaneUrl: "https://x", sessionToken: "good-session", principalId: "p1", deviceKey: key, lifetimeMs: 7_200_000, fetch: fakeControlPlane(world, "p1", { calls, record: false }) });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({ lifetimeMs: 7_200_000 });
  });

  it("reports a refusal with its status and reason, and never sends the secret", async () => {
    const key = await createDeviceKey();
    await expect(enroll({ controlPlaneUrl: "https://x", sessionToken: "stale", principalId: "p1", deviceKey: key, fetch: fakeControlPlane(world, "p1", { record: false }) })).rejects.toMatchObject({ name: "EnrollmentError", status: 401 });

    // A proof for another principal is refused by the verifier, which the double mirrors.
    const err = await enroll({ controlPlaneUrl: "https://x", sessionToken: "good-session", principalId: "someone-else", deviceKey: key, fetch: fakeControlPlane(world, "p1", { record: false }) }).catch((e: unknown) => e);
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
        return fakeControlPlane(world, "p1", { record: false })(i, init);
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
