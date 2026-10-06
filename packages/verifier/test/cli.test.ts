import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bytesToHex } from "@omnisync/protocol";
import { main } from "../src/cli.js";
import { Fixture, issuer, ledger } from "./fixture.js";

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
  it("exits 0 and prints a report for a good export", async () => {
    const r = await run(["verify", good, "--issuer", issuerHex(), "--ledger-key", ledgerHex()]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/RESULT: VERIFIED/);
    expect(r.out).toMatch(/entries:\s+2/);
  });

  it("exits 1 and names the violation for a damaged export", async () => {
    const r = await run(["verify", bad, "--issuer", issuerHex(), "--ledger-key", ledgerHex()]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/RESULT: FAILED/);
    expect(r.out).toMatch(/VIOLATION chain_gap/);
  });

  it("reads keys from @files, prints JSON, and compares against a locked directory", async () => {
    const r = await run(["verify", good, "--issuer", `@${join(dir, "issuer.pub")}`, "--ledger-key", ledgerHex(), "--json", "--locked", join(dir, "locked")]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, counts: { entries: 2, checkpoints: 1 } });
  });

  it("a wrong ledger key fails the checkpoint check", async () => {
    const r = await run(["verify", good, "--issuer", issuerHex(), "--ledger-key", issuerHex()]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/checkpoint_signature/);
  });

  it("treats unparseable lines as violations, not crashes", async () => {
    const p = join(dir, "junk.ndjson");
    await writeFile(p, f.lines().join("\n") + "\nthis is not json\n\n");
    const r = await run(["verify", p, "--issuer", issuerHex(), "--ledger-key", ledgerHex()]);
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
      expect((await run(["verify", good, "--issuer", issuerHex(), "--ledger-key", ledgerHex(), "--bogus"])).code).toBe(2);
      expect((await run(["verify", good, "--issuer", issuerHex(), "--ledger-key", ledgerHex(), "--grace-ms", "-5"])).code).toBe(2);
      expect((await run(["verify", good, "--issuer"])).code).toBe(2);
      expect((await run(["verify", join(dir, "nope.ndjson"), "--issuer", issuerHex(), "--ledger-key", ledgerHex()])).code).toBe(2);
    } finally {
      process.stderr.write = origErr;
    }
  });
});
