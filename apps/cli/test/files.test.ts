import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPair } from "@omnisync/protocol";
import { ProfileError, homeDir, loadKey, loadProfile, removeAll, saveKey, saveProfile, type Profile } from "../src/files.js";

const posix = process.platform !== "win32";
const dirs: string[] = [];
const fresh = async (): Promise<string> => {
  const d = join(await mkdtemp(join(tmpdir(), "omnisync-cli-")), "home");
  dirs.push(d);
  return d;
};
afterEach(async () => {
  await Promise.allSettled(dirs.splice(0).map((d) => rm(join(d, ".."), { recursive: true, force: true })));
});
const mode = async (p: string) => (await stat(p)).mode & 0o777;

const PROFILE: Profile = {
  server: "https://cp.example.com",
  gateway: "wss://sync.example.com",
  principalId: "p_1234",
  email: "alice@example.com",
  keyId: "0102030405060708",
  serial: "ab".repeat(16),
  notAfterMs: 1_900_000_000_000,
  certificate: "Q0VSVA",
};

describe("home directory", () => {
  it("is OMNISYNC_HOME, else ~/.omnisync, else an error", () => {
    expect(homeDir({ OMNISYNC_HOME: "/x/y", HOME: "/h" })).toBe("/x/y");
    expect(homeDir({ HOME: "/h" })).toBe(join("/h", ".omnisync"));
    expect(homeDir({ USERPROFILE: "C:\\Users\\a" })).toBe(join("C:\\Users\\a", ".omnisync"));
    expect(() => homeDir({})).toThrow(ProfileError);
    expect(() => homeDir({ OMNISYNC_HOME: "relative/dir" })).toThrow(/absolute/);
  });
});

describe.skipIf(!posix)("key file", () => {
  it("is created private, in a private directory, and loads back as the same key", async () => {
    const dir = await fresh();
    const pair = generateKeyPair();
    await saveKey(dir, pair);
    expect(await mode(dir)).toBe(0o700);
    expect(await mode(join(dir, "key.json"))).toBe(0o600);
    const back = await loadKey(dir);
    expect(back?.publicKey).toEqual(pair.publicKey);
    expect(back?.secretKey).toEqual(pair.secretKey);
    expect(await readdir(dir)).toEqual(["key.json"]); // no temporary file left behind
  });

  it("is absent until saved, and is never overwritten", async () => {
    const dir = await fresh();
    expect(await loadKey(dir)).toBeUndefined();
    const first = generateKeyPair();
    await saveKey(dir, first);
    await expect(saveKey(dir, generateKeyPair())).rejects.toThrow(/already exists/);
    expect((await loadKey(dir))?.publicKey).toEqual(first.publicKey);
    expect(await readdir(dir)).toEqual(["key.json"]);
  });

  it("is refused when anyone else can read it, and says how to fix that", async () => {
    const dir = await fresh();
    await saveKey(dir, generateKeyPair());
    for (const m of [0o640, 0o604, 0o644, 0o660, 0o666, 0o410, 0o601]) {
      await chmod(join(dir, "key.json"), m);
      await expect(loadKey(dir), m.toString(8)).rejects.toThrow(/chmod 600/);
    }
    await chmod(join(dir, "key.json"), 0o400); // read-only for the owner is fine
    expect(await loadKey(dir)).toBeDefined();
  });

  it("is refused when its directory is open to others", async () => {
    const dir = await fresh();
    await saveKey(dir, generateKeyPair());
    await chmod(dir, 0o755);
    await expect(loadKey(dir)).rejects.toThrow(/chmod 700/);
    await expect(saveKey(dir, generateKeyPair())).rejects.toThrow(/chmod 700/);
  });

  it("is refused when damaged, wrong, or not a plain file", async () => {
    const dir = await fresh();
    await mkdir(dir, { mode: 0o700 });
    const seed = "11".repeat(32);
    const pair = generateKeyPair(Uint8Array.from(Buffer.from(seed, "hex")));
    const good = { v: 1, secretKey: seed, publicKey: Buffer.from(pair.publicKey).toString("hex") };
    const put = async (v: unknown) => {
      await rm(join(dir, "key.json"), { force: true });
      await writeFile(join(dir, "key.json"), typeof v === "string" ? v : JSON.stringify(v), { mode: 0o600 });
    };
    await put(good);
    expect(await loadKey(dir)).toBeDefined();
    for (const bad of ["", "{not json", "null", "[]", { ...good, v: 2 }, { ...good, secretKey: "11".repeat(31) }, { ...good, secretKey: "zz".repeat(32) }, { ...good, publicKey: "22".repeat(32) }, { ...good, publicKey: 5 }, { v: 1 }]) {
      await put(bad);
      await expect(loadKey(dir), JSON.stringify(bad)).rejects.toThrow(ProfileError);
    }
    await rm(join(dir, "key.json"));
    await mkdir(join(dir, "key.json"), { mode: 0o700 });
    await expect(loadKey(dir)).rejects.toThrow(ProfileError);
  });

  it("never prints the secret in an error", async () => {
    const dir = await fresh();
    await mkdir(dir, { mode: 0o700 });
    await writeFile(join(dir, "key.json"), JSON.stringify({ v: 1, secretKey: "ab".repeat(32), publicKey: "cd".repeat(32) }), { mode: 0o600 });
    const err = await loadKey(dir).catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain("ab".repeat(8));
  });
});

describe.skipIf(!posix)("profile", () => {
  it("is private, round-trips, and holds no secret key", async () => {
    const dir = await fresh();
    await saveProfile(dir, PROFILE);
    expect(await mode(join(dir, "profile.json"))).toBe(0o600);
    expect(await loadProfile(dir)).toEqual(PROFILE);
    const raw = await readFile(join(dir, "profile.json"), "utf8");
    expect(raw).not.toMatch(/secret|seed|token/i);
    expect(await readdir(dir)).toEqual(["profile.json"]);
  });

  it("may be replaced (a new certificate), atomically", async () => {
    const dir = await fresh();
    await saveProfile(dir, PROFILE);
    await saveProfile(dir, { ...PROFILE, serial: "cd".repeat(16), notAfterMs: PROFILE.notAfterMs + 1 });
    expect((await loadProfile(dir))?.serial).toBe("cd".repeat(16));
    expect(await readdir(dir)).toEqual(["profile.json"]);
  });

  it("is absent until saved; the gateway is optional", async () => {
    const dir = await fresh();
    expect(await loadProfile(dir)).toBeUndefined();
    const noGateway: Profile = { ...PROFILE };
    delete noGateway.gateway;
    await saveProfile(dir, noGateway);
    expect(await loadProfile(dir)).toEqual(noGateway);
  });

  it("is refused when damaged or when a field has the wrong shape", async () => {
    const dir = await fresh();
    await mkdir(dir, { mode: 0o700 });
    const put = (v: unknown) => writeFile(join(dir, "profile.json"), typeof v === "string" ? v : JSON.stringify(v), { mode: 0o600 });
    for (const bad of ["", "{x", "null", "[]", { ...PROFILE, server: 5 }, { ...PROFILE, notAfterMs: "soon" }, { ...PROFILE, serial: "xyz" }, { ...PROFILE, certificate: "" }, { ...PROFILE, principalId: "" }, { ...PROFILE, keyId: "zz" }, { ...PROFILE, gateway: 5 }]) {
      await put(bad);
      await expect(loadProfile(dir), JSON.stringify(bad)).rejects.toThrow(ProfileError);
    }
  });
});

describe.skipIf(!posix)("logout", () => {
  it("removes the key and the profile and nothing else, and may be repeated", async () => {
    const dir = await fresh();
    await saveKey(dir, generateKeyPair());
    await saveProfile(dir, PROFILE);
    await writeFile(join(dir, "notes.txt"), "mine");
    await removeAll(dir);
    expect((await readdir(dir)).sort()).toEqual(["notes.txt"]);
    await removeAll(dir);
    await removeAll(join(dir, "nowhere"));
  });
});
