import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyEnrollmentProof } from "@omnisync/crypto";
import { UsageError } from "../src/args.js";
import { checkServer, login, whoami } from "../src/login.js";
import { loadKey, loadProfile } from "../src/files.js";

const SESSION = "SESSION.TOKEN-never-on-disk";
const DEVICE_CODE = "devicecode".padEnd(43, "x");
const SERVER = "https://cp.example.com";
const posix = process.platform !== "win32";

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Fake {
  fetch: typeof fetch;
  calls: { url: string; method: string; body: unknown; auth: string | null }[];
  /** What the approver does: how many pending answers before the verdict. */
  verdict: "approve" | "deny" | "expire";
  pendingFirst: number;
  startOverride?: Record<string, unknown>;
  enrollFails?: boolean;
  proofs: { principalId: string; publicKey: Uint8Array; proof: Uint8Array }[];
}
function fake(): Fake {
  const f: Fake = { calls: [], verdict: "approve", pendingFirst: 1, proofs: [], fetch: undefined as never };
  let polls = 0;
  f.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const auth = new Headers(init?.headers).get("authorization");
    const path = new URL(url).pathname;
    f.calls.push({ url, method: init?.method ?? "GET", body, auth });
    if (path === "/v1/auth/device") {
      return json(200, { deviceCode: DEVICE_CODE, userCode: "BCDF-GHJK", verificationUri: "https://app.example.com/", verificationUriComplete: "https://app.example.com/?device=BCDF-GHJK", expiresInS: 600, intervalS: 5, ...f.startOverride });
    }
    if (path === "/v1/auth/device/token") {
      if (polls++ < f.pendingFirst) return json(400, { error: "authorization_pending" });
      if (f.verdict === "deny") return json(400, { error: "access_denied" });
      if (f.verdict === "expire") return json(400, { error: "expired_token" });
      return json(200, { sessionToken: SESSION });
    }
    if (path === "/v1/me") return auth === `Bearer ${SESSION}` ? json(200, { id: "p_alice", email: "alice@example.com", displayName: "Alice", orgRole: "member" }) : json(401, { error: "no" });
    if (path === "/v1/certificates") {
      if (f.enrollFails) return json(400, { message: "proof of key possession is invalid" });
      const b = body as { publicKey: string; proof: string };
      f.proofs.push({ principalId: "p_alice", publicKey: new Uint8Array(Buffer.from(b.publicKey, "base64url")), proof: new Uint8Array(Buffer.from(b.proof, "base64url")) });
      return json(201, { certificate: Buffer.from("signed-certificate").toString("base64url"), serial: "ab".repeat(16), subject: "p_alice", notBeforeMs: 1_000, notAfterMs: 1_000 + 12 * 3_600_000 });
    }
    return json(404, { error: "no route" });
  }) as typeof fetch;
  return f;
}

const dirs: string[] = [];
const fresh = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "omnisync-login-"));
  dirs.push(root);
  return join(root, "home");
};
afterEach(async () => {
  await Promise.allSettled(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const run = async (f: Fake, dir: string, over: Partial<Parameters<typeof login>[0]> = {}) => {
  const out: string[] = [];
  const sleeps: number[] = [];
  const profile = await login(
    { server: SERVER, label: "build box", dir, ...over },
    { out: (l) => out.push(l), fetch: f.fetch, sleep: async (ms) => void sleeps.push(ms), now: () => 1_000 },
  ).catch((e: unknown) => e);
  return { profile, out, sleeps };
};

describe("server address", () => {
  it("is an https origin, or http on this machine", () => {
    expect(checkServer("https://cp.example.com/")).toBe("https://cp.example.com");
    expect(checkServer("https://cp.example.com:8443")).toBe("https://cp.example.com:8443");
    expect(checkServer("http://localhost:8081")).toBe("http://localhost:8081");
    expect(checkServer("http://127.0.0.1:8081/")).toBe("http://127.0.0.1:8081");
  });
  it("refuses everything else", () => {
    for (const bad of ["http://cp.example.com", "ftp://cp.example.com", "cp.example.com", "https://u:p@cp.example.com", "https://cp.example.com/api", "https://cp.example.com?x=1", "https://cp.example.com/#x", "", "javascript:alert(1)", "http://localhost.evil.example"]) {
      expect(() => checkServer(bad), bad).toThrow(UsageError);
    }
  });
});

describe("login", () => {
  it("shows the code, waits to be approved, enrols the key and writes the profile", async () => {
    const dir = await fresh();
    const f = fake();
    const { profile, out, sleeps } = await run(f, dir);
    expect(profile).toMatchObject({ server: SERVER, principalId: "p_alice", email: "alice@example.com", serial: "ab".repeat(16), notAfterMs: 1_000 + 12 * 3_600_000, certificate: Buffer.from("signed-certificate").toString("base64url") });
    const text = out.join("\n");
    expect(text).toContain("https://app.example.com/?device=BCDF-GHJK");
    expect(text).toContain("BCDF-GHJK");
    expect(sleeps).toEqual([5000, 5000]); // one pending answer, then approved
    expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual(["/v1/auth/device", "/v1/auth/device/token", "/v1/auth/device/token", "/v1/me", "/v1/certificates"]);
    expect(f.calls[0]?.body).toEqual({ label: "build box" });
    expect(f.calls[4]?.auth).toBe(`Bearer ${SESSION}`);
    expect(await loadProfile(dir)).toEqual(profile);
  });

  it("proves possession of the key it stored", async () => {
    const dir = await fresh();
    const f = fake();
    await run(f, dir);
    const key = await loadKey(dir);
    expect(key).toBeDefined();
    expect(f.proofs).toHaveLength(1);
    expect(f.proofs[0]?.publicKey).toEqual(key?.publicKey);
    expect(verifyEnrollmentProof("p_alice", f.proofs[0]?.publicKey as Uint8Array, f.proofs[0]?.proof as Uint8Array)).toBe(true);
    expect(((await loadProfile(dir))?.keyId)).toBe(Buffer.from((await import("@omnisync/protocol")).keyIdOf(key?.publicKey as Uint8Array)).toString("hex"));
  });

  it.skipIf(!posix)("keeps the session token and the device code out of the output and off the disk", async () => {
    const dir = await fresh();
    const f = fake();
    const { out } = await run(f, dir);
    expect(out.join("\n")).not.toContain(SESSION);
    expect(out.join("\n")).not.toContain(DEVICE_CODE);
    for (const name of await readdir(dir)) {
      const text = await readFile(join(dir, name), "utf8");
      expect(text, name).not.toContain(SESSION);
      expect(text, name).not.toContain(DEVICE_CODE);
    }
    expect((await stat(join(dir, "key.json"))).mode & 0o777).toBe(0o600);
  });

  it("keeps the same device key when it signs in again, and replaces the certificate", async () => {
    const dir = await fresh();
    await run(fake(), dir);
    const first = await loadKey(dir);
    const again = fake();
    await run(again, dir);
    expect((await loadKey(dir))?.publicKey).toEqual(first?.publicKey);
    expect(again.proofs[0]?.publicKey).toEqual(first?.publicKey);
  });

  it("creates no key when the person says no or is too slow", async () => {
    for (const verdict of ["deny", "expire"] as const) {
      const dir = await fresh();
      const f = fake();
      f.verdict = verdict;
      const { profile } = await run(f, dir);
      expect(profile).toMatchObject({ name: "DeviceLoginError", code: verdict === "deny" ? "access_denied" : "expired_token" });
      expect(await loadKey(dir)).toBeUndefined();
      expect(await loadProfile(dir)).toBeUndefined();
    }
  });

  it("writes no profile when enrolment is refused, and says why; the key is kept for the next try", async () => {
    const dir = await fresh();
    const f = fake();
    f.enrollFails = true;
    const { profile } = await run(f, dir);
    expect(String((profile as Error).message)).toContain("proof of key possession is invalid");
    expect(await loadProfile(dir)).toBeUndefined();
    expect(await loadKey(dir)).toBeDefined();
  });

  it("refuses a verification address that is not a plain web link, before waiting for anything", async () => {
    for (const uri of ["javascript:alert(1)", "file:///etc/passwd", "https://app.example.com/\u001b[2J", "https://app.example.com/ x", "ssh://host"]) {
      const f = fake();
      f.startOverride = { verificationUriComplete: uri };
      const { profile } = await run(f, await fresh());
      expect(profile, uri).toBeInstanceOf(Error);
      expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual(["/v1/auth/device"]);
    }
    const f = fake();
    f.startOverride = { userCode: "BCDF-GHJK\u001b[31m" };
    expect(((await run(f, await fresh())).profile)).toBeInstanceOf(Error);
  });

  it("records the gateway when given, and refuses an address that is not ws or wss", async () => {
    const dir = await fresh();
    const ok = await run(fake(), dir, { gateway: "wss://sync.example.com/" });
    expect((ok.profile as { gateway: string }).gateway).toBe("wss://sync.example.com");
    expect((await run(fake(), await fresh(), { gateway: "https://sync.example.com" })).profile).toBeInstanceOf(UsageError);
    expect((await run(fake(), await fresh(), { gateway: "ws://sync.example.com" })).profile).toBeInstanceOf(UsageError); // plain ws only on this machine
    expect(((await run(fake(), await fresh(), { gateway: "ws://localhost:8080" })).profile as { gateway: string }).gateway).toBe("ws://localhost:8080");
    for (const bad of ["wss://sync.example.com/path", "wss://sync.example.com?x=1", "wss://sync.example.com/#x", "wss://u:p@sync.example.com", "sync.example.com"]) {
      expect((await run(fake(), await fresh(), { gateway: bad })).profile, bad).toBeInstanceOf(UsageError);
    }
  });

  it("works from a server with a trailing slash and uses it as the profile's server", async () => {
    const { profile } = await run(fake(), await fresh(), { server: "https://cp.example.com/" });
    expect((profile as { server: string }).server).toBe(SERVER);
  });
});

describe("whoami", () => {
  const profile = { server: SERVER, principalId: "p_alice", email: "alice@example.com", keyId: "01".repeat(8), serial: "ab".repeat(16), notAfterMs: 10_000_000, certificate: "Q0VSVA" };
  it("tells who and until when, and is ok while the certificate lasts", () => {
    const w = whoami(profile, 9_000_000);
    expect(w).toMatchObject({ ok: true });
    expect(w.lines.join("\n")).toContain("alice@example.com");
    expect(w.lines.join("\n")).toContain("p_alice");
    expect(w.lines.join("\n")).toContain(new Date(10_000_000).toISOString());
    expect(w.lines.join("\n")).toContain("ab".repeat(16));
  });
  it("is not ok when the certificate has run out, and says so (the moment of expiry counts as expired)", () => {
    expect(whoami(profile, 10_000_000 - 1).ok).toBe(true);
    for (const now of [10_000_000, 10_000_001]) {
      const w = whoami(profile, now);
      expect(w.ok).toBe(false);
      expect(w.lines.join("\n")).toMatch(/expired/);
    }
  });
  it("names the principal when the profile has no email", () => {
    const w = whoami({ ...profile, email: "" }, 1);
    expect(w.lines[0]).toBe("signed in as p_alice (p_alice)");
    expect(whoami(profile, 1).lines[0]).toBe("signed in as alice@example.com (p_alice)");
  });
  it("is not ok without a profile", () => {
    const w = whoami(undefined, 0);
    expect(w.ok).toBe(false);
    expect(w.lines.join("\n")).toMatch(/not signed in/);
  });
});
