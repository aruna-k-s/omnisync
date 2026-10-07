import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { saveKey, saveProfile } from "../src/files.js";
import { generateKeyPair } from "@omnisync/protocol";

const dirs: string[] = [];
const home = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "omnisync-cli-run-"));
  dirs.push(root);
  return join(root, "h");
};
afterEach(async () => {
  await Promise.allSettled(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const goodFetch = (labels: string[] = []): typeof fetch =>
  (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/v1/auth/device") {
      labels.push(JSON.parse(String(init?.body)).label);
      return json(200, { deviceCode: "d".repeat(43), userCode: "BCDF-GHJK", verificationUri: "https://app.example.com/", verificationUriComplete: "https://app.example.com/?device=BCDF-GHJK", expiresInS: 600, intervalS: 5 });
    }
    if (path === "/v1/auth/device/token") return json(200, { sessionToken: "tok" });
    if (path === "/v1/me") return json(200, { id: "p_alice", email: "alice@example.com", displayName: "Alice", orgRole: "member" });
    if (path === "/v1/certificates") return json(201, { certificate: "Q0VSVA", serial: "ab".repeat(16), subject: "p_alice", notBeforeMs: 0, notAfterMs: 5_000_000_000_000 });
    return json(404, {});
  }) as typeof fetch;

async function go(argv: string[], env: Record<string, string>, deps: Parameters<typeof run>[3] = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, env, { out: (l) => out.push(l), err: (l) => err.push(l) }, deps);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("omnisync-cli", () => {
  it("prints usage for help and exits 0; a usage error prints the problem and the usage, exit 2", async () => {
    const help = await go(["--help"], {});
    expect(help.code).toBe(0);
    expect(help.out).toContain("usage: omnisync-cli");
    const bad = await go(["login"], { OMNISYNC_HOME: await home() });
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("--server");
    expect(bad.err).toContain("usage: omnisync-cli");
    expect((await go(["login", "--server", "http://evil.example"], { OMNISYNC_HOME: await home() }, { fetch: goodFetch() })).code).toBe(2);
  });

  it("logs in, whoami reports it, logout forgets it", async () => {
    const env = { OMNISYNC_HOME: await home() };
    const labels: string[] = [];
    const login = await go(["login", "--server", "https://cp.example.com", "--label", "ci box"], env, { fetch: goodFetch(labels), sleep: async () => undefined });
    expect(login.code).toBe(0);
    expect(login.out).toContain("BCDF-GHJK");
    expect(login.out).toContain("Signed in as alice@example.com");
    expect(labels).toEqual(["ci box"]);
    expect(login.out).not.toContain("tok");

    const who = await go(["whoami"], env, { now: () => 1_000 });
    expect(who.code).toBe(0);
    expect(who.out).toContain("alice@example.com");
    expect((await go(["whoami"], env, { now: () => 6_000_000_000_000 })).code).toBe(1);

    const out = await go(["logout"], env);
    expect(out.code).toBe(0);
    expect(out.out).toMatch(/signed out/i);
    expect(out.out).toContain("revoke"); // the certificate stays valid until it expires or an admin revokes it
    expect((await go(["whoami"], env)).code).toBe(1);
    expect(await readdir(env.OMNISYNC_HOME)).toEqual([]);
    expect((await go(["logout"], env)).code).toBe(0); // idempotent
  });

  it("labels the device with user and host when no label is given, with nothing unprintable", async () => {
    const labels: string[] = [];
    await go(["login", "--server", "https://cp.example.com"], { OMNISYNC_HOME: await home() }, { fetch: goodFetch(labels), sleep: async () => undefined, who: () => "al\u001bice@bu\nild-1" });
    expect(labels).toEqual(["alice@build-1"]);
  });

  it("cuts a long label to 64 characters", async () => {
    const labels: string[] = [];
    await go(["login", "--server", "https://cp.example.com", "--label", "x".repeat(200)], { OMNISYNC_HOME: await home() }, { fetch: goodFetch(labels), sleep: async () => undefined });
    expect(labels[0]).toHaveLength(64);
  });

  it("says when the certificate stays valid after logout, and nothing about it once it has expired", async () => {
    const env = { OMNISYNC_HOME: await home() };
    await go(["login", "--server", "https://cp.example.com"], env, { fetch: goodFetch(), sleep: async () => undefined });
    const expired = await go(["logout"], env, { now: () => 9_000_000_000_000 });
    expect(expired.out).not.toContain("stays valid");
    await go(["login", "--server", "https://cp.example.com"], env, { fetch: goodFetch(), sleep: async () => undefined });
    const valid = await go(["logout"], env, { now: () => 1_000 });
    expect(valid.out).toContain(`stays valid until ${new Date(5_000_000_000_000).toISOString()}`);
  });

  it("takes the server and gateway from the environment", async () => {
    const env = { OMNISYNC_HOME: await home(), OMNISYNC_SERVER: "https://cp.example.com", OMNISYNC_GATEWAY: "wss://sync.example.com" };
    expect((await go(["login"], env, { fetch: goodFetch(), sleep: async () => undefined })).code).toBe(0);
    expect((await go(["whoami"], env, { now: () => 1 })).out).toContain("wss://sync.example.com");
  });

  it("reports a refused or cancelled login with exit 1 and no stack trace", async () => {
    const env = { OMNISYNC_HOME: await home() };
    const denied: typeof fetch = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/v1/auth/device") return goodFetch()(url, init);
      return json(400, { error: "access_denied" });
    }) as typeof fetch;
    const r = await go(["login", "--server", "https://cp.example.com"], env, { fetch: denied, sleep: async () => undefined });
    expect(r.code).toBe(1);
    expect(r.err).toContain("denied");
    expect(r.err).not.toContain("    at ");
    const down = await go(["login", "--server", "https://cp.example.com"], env, { fetch: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch });
    expect(down.code).toBe(1);
    expect(down.err).toContain("ECONNREFUSED");
    const ctl = new AbortController();
    ctl.abort();
    const cancelled = await go(["login", "--server", "https://cp.example.com"], env, { fetch: goodFetch(), signal: ctl.signal, sleep: async () => undefined });
    expect(cancelled.code).toBe(1);
    expect(cancelled.err).toBe("cancelled");
  });

  it.skipIf(process.platform === "win32")("refuses to work with a key anyone else can read, exit 1", async () => {
    const dir = await home();
    await saveKey(dir, generateKeyPair());
    const { chmod } = await import("node:fs/promises");
    await chmod(join(dir, "key.json"), 0o644);
    const r = await go(["login", "--server", "https://cp.example.com"], { OMNISYNC_HOME: dir }, { fetch: goodFetch(), sleep: async () => undefined });
    expect(r.code).toBe(1);
    expect(r.err).toContain("chmod 600");
  });

  it.skipIf(process.platform === "win32")("whoami says what is wrong with a damaged profile instead of crashing", async () => {
    const dir = await home();
    await saveProfile(dir, { server: "https://x", principalId: "p", email: "", keyId: "01".repeat(8), serial: "ab".repeat(16), notAfterMs: 1, certificate: "x" });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "profile.json"), "{broken", { mode: 0o600 });
    const r = await go(["whoami"], { OMNISYNC_HOME: dir });
    expect(r.code).toBe(1);
    expect(r.err).toContain("profile.json");
  });
});
