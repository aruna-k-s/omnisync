import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bytesToHex } from "@omnisync/protocol";
import { main } from "../src/cli.js";
import { Fixture, issuer, ledger, stranger } from "./fixture.js";

let dir: string;
let good: string;
let bad: string;
let f: Fixture;
const issuerHex = () => bytesToHex(issuer.publicKey);
const ledgerHex = () => bytesToHex(ledger.publicKey);

async function run(args: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await main(args, (s) => void (out += s));
  return { code, out };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "omnisync-cli-"));
  f = new Fixture();
  const u = f.addUser(1);
  f.append("d", u);
  f.append("d", u);
  await f.checkpoint();
  good = join(dir, "good.ndjson");
  bad = join(dir, "bad.ndjson");
  await writeFile(good, f.lines().join("\n") + "\n");
  await writeFile(bad, f.lines().filter((l) => !l.includes('"seq":1,')).join("\n") + "\n");
  await writeFile(join(dir, "issuer.pub"), issuerHex() + "\n");
  await mkdir(join(dir, "locked"));
  await writeFile(join(dir, "locked", "000000000001.ckpt"), f.checkpoints[0] as Uint8Array);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("omnisync verify", () => {
  const base = () => ["--issuer", issuerHex(), "--ledger-key", ledgerHex()];
  const lockedArgs = () => ["--locked", join(dir, "locked")];

  it("exits 0 and says anchored when the export matches the locked checkpoints", async () => {
    const r = await run(["verify", good, ...base(), ...lockedArgs(), "--tenant", "acme"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RESULT: VERIFIED and anchored to 1 locked checkpoint/);
    expect(r.out).toMatch(/entries:\s+2/);
  });

  it("exits 3 for a consistent export that was not compared with locked checkpoints, unless told it is fine", async () => {
    const r = await run(["verify", good, ...base()]);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/CONSISTENT, NOT ANCHORED/);
    expect(r.out).not.toMatch(/VERIFIED/);
    expect((await run(["verify", good, ...base(), "--allow-unanchored"])).code).toBe(0);
  });

  it("exits 1 and names the violation for a damaged export", async () => {
    const r = await run(["verify", bad, ...base(), ...lockedArgs()]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/RESULT: FAILED/);
    expect(r.out).toMatch(/VIOLATION chain_gap/);
  });

  it("reads keys from @files, prints JSON, and reports anchoring in it", async () => {
    const r = await run(["verify", good, "--issuer", `@${join(dir, "issuer.pub")}`, "--ledger-key", ledgerHex(), "--json", ...lockedArgs()]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, anchored: true, lockedChecked: 1, counts: { entries: 2, checkpoints: 1 } });
  });

  it("a ledger key that does not match fails the checkpoint check; one equal to an issuer key is unusable input", async () => {
    const wrong = await run(["verify", good, "--issuer", issuerHex(), "--ledger-key", bytesToHex(stranger.publicKey)]);
    expect(wrong.code).toBe(1);
    expect(wrong.out).toMatch(/checkpoint_signature/);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect((await run(["verify", good, "--issuer", issuerHex(), "--ledger-key", issuerHex()])).code).toBe(2);
    } finally {
      process.stderr.write = origErr;
    }
  });

  it("pins the tenant", async () => {
    const r = await run(["verify", good, ...base(), ...lockedArgs(), "--tenant", "globex"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/tenant_mismatch/);
  });

  it("refuses erased frames unless --allow-erased", async () => {
    const p = join(dir, "erased.ndjson");
    const lines = f.lines().map((l) => {
      const o = JSON.parse(l) as Record<string, unknown>;
      if (o.t === "entry") delete o.frame;
      return JSON.stringify(o);
    });
    await writeFile(p, lines.join("\n") + "\n");
    const strict = await run(["verify", p, ...base(), ...lockedArgs()]);
    expect(strict.code).toBe(1);
    expect(strict.out).toMatch(/frame_erased/);
    expect((await run(["verify", p, ...base(), ...lockedArgs(), "--allow-erased"])).code).toBe(0);
  });

  it("finds locked checkpoints at any depth, as an object-store sync lays them out", async () => {
    const deep = join(dir, "bucket", "checkpoints", "61636d65");
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, "000000000001.ckpt"), f.checkpoints[0] as Uint8Array);
    await writeFile(join(deep, "notes.txt"), "ignored");
    const r = await run(["verify", good, ...base(), "--locked", join(dir, "bucket")]);
    expect(r.code).toBe(0);
  });

  it("refuses a locked directory that is empty, has no checkpoint files, or holds one number twice", async () => {
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await mkdir(join(dir, "empty"));
      expect((await run(["verify", good, ...base(), "--locked", join(dir, "empty")])).code).toBe(2);
      await mkdir(join(dir, "junk"));
      await writeFile(join(dir, "junk", "1.ckpt"), "x"); // not the 12-digit name the writer produces
      expect((await run(["verify", good, ...base(), "--locked", join(dir, "junk")])).code).toBe(2);
      await mkdir(join(dir, "twice", "a"), { recursive: true });
      await mkdir(join(dir, "twice", "b"), { recursive: true });
      await writeFile(join(dir, "twice", "a", "000000000001.ckpt"), f.checkpoints[0] as Uint8Array);
      await writeFile(join(dir, "twice", "b", "000000000001.ckpt"), new Uint8Array([1]));
      expect((await run(["verify", good, ...base(), "--locked", join(dir, "twice")])).code).toBe(2);
      expect((await run(["verify", good, ...base(), "--locked", join(dir, "does-not-exist")])).code).toBe(2);
    } finally {
      process.stderr.write = origErr;
    }
  });

  it("treats unparseable lines as violations, not crashes", async () => {
    const p = join(dir, "junk.ndjson");
    await writeFile(p, f.lines().join("\n") + "\nthis is not json\n\n");
    const r = await run(["verify", p, ...base()]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/export_malformed/);
  });

  it("exits 2 on bad usage, missing keys, bad keys and a missing file", async () => {
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect((await run([])).code).toBe(2);
      expect((await run(["verify"])).code).toBe(2);
      expect((await run(["verify", good])).code).toBe(2);
      expect((await run(["verify", good, "--issuer", "zz", "--ledger-key", ledgerHex()])).code).toBe(2);
      expect((await run(["verify", good, ...base(), "--bogus"])).code).toBe(2);
      expect((await run(["verify", good, ...base(), "--grace-ms", "-5"])).code).toBe(2);
      expect((await run(["verify", good, "--issuer"])).code).toBe(2);
      expect((await run(["verify", join(dir, "nope.ndjson"), ...base()])).code).toBe(2);
    } finally {
      process.stderr.write = origErr;
    }
  });
});
