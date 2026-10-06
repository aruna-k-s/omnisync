import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPair, bytesToHex } from "@omnisync/protocol";
import { loadLedgerConfig } from "../src/index.js";

const SEED = "ab".repeat(32);
let dir: string;
let keyFile: string;
const env = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  OMNISYNC_TENANT: "acme",
  OMNISYNC_CHECKPOINT_DIR: join(dir, "locked"),
  OMNISYNC_DATA_DIR: join(dir, "data"),
  OMNISYNC_LEDGER_KEY_FILE: keyFile,
  ...over,
});
const issuer = [bytesToHex(generateKeyPair(new Uint8Array(32).fill(5)).publicKey)];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omnisync-cfg-"));
  keyFile = join(dir, "ledger.key");
  await writeFile(keyFile, SEED + "\n", { mode: 0o600 });
  await chmod(keyFile, 0o600);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadLedgerConfig", () => {
  it("loads a valid configuration", async () => {
    const c = await loadLedgerConfig(env(), issuer);
    expect(c.tenant).toBe("acme");
    expect(c.signer.keyId).toHaveLength(8);
    expect(c.signer.publicKey).toHaveLength(32);
  });

  it("requires the tenant and the checkpoint directory instead of defaulting them", async () => {
    await expect(loadLedgerConfig(env({ OMNISYNC_TENANT: undefined }), issuer)).rejects.toThrow(/OMNISYNC_TENANT/);
    await expect(loadLedgerConfig(env({ OMNISYNC_CHECKPOINT_DIR: undefined }), issuer)).rejects.toThrow(/OMNISYNC_CHECKPOINT_DIR/);
    await expect(loadLedgerConfig(env({ OMNISYNC_LEDGER_KEY_FILE: undefined }), issuer)).rejects.toThrow(/OMNISYNC_LEDGER_KEY_FILE/);
  });

  it("rejects a tenant that cannot be signed", async () => {
    await expect(loadLedgerConfig(env({ OMNISYNC_TENANT: "x".repeat(65) }), issuer)).rejects.toThrow(/TENANT/);
    await expect(loadLedgerConfig(env({ OMNISYNC_TENANT: "a\ud800" }), issuer)).rejects.toThrow(/TENANT/);
  });

  it("refuses a key file other users can read", async () => {
    await chmod(keyFile, 0o640);
    await expect(loadLedgerConfig(env(), issuer)).rejects.toThrow(/readable by group or others/);
    await chmod(keyFile, 0o604);
    await expect(loadLedgerConfig(env(), issuer)).rejects.toThrow(/readable by group or others/);
  });

  it("refuses a key file that is missing, a directory, or not 64 hex characters, without printing the contents", async () => {
    await expect(loadLedgerConfig(env({ OMNISYNC_LEDGER_KEY_FILE: join(dir, "nope") }), issuer)).rejects.toThrow(/cannot be read/);
    await expect(loadLedgerConfig(env({ OMNISYNC_LEDGER_KEY_FILE: dir }), issuer)).rejects.toThrow(/regular file/);
    await writeFile(keyFile, "zz".repeat(32), { mode: 0o600 });
    const err = await loadLedgerConfig(env(), issuer).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/64 lowercase hex/);
    expect((err as Error).message).not.toContain("zz");
  });

  it("refuses a ledger key that is also a certificate issuing key, however the hex is cased or padded", async () => {
    const same = bytesToHex(generateKeyPair(Uint8Array.from(Buffer.from(SEED, "hex"))).publicKey);
    await expect(loadLedgerConfig(env(), [same])).rejects.toThrow(/issuing key/);
    await expect(loadLedgerConfig(env(), [` ${same.toUpperCase()} `])).rejects.toThrow(/issuing key/);
  });

  it("refuses to put checkpoints in the snapshot directory", async () => {
    await expect(loadLedgerConfig(env({ OMNISYNC_CHECKPOINT_DIR: join(dir, "data") }), issuer)).rejects.toThrow(/snapshot directory/);
    await expect(loadLedgerConfig(env({ OMNISYNC_CHECKPOINT_DIR: join(dir, "data", "..", "data") }), issuer)).rejects.toThrow(/snapshot directory/);
  });
});
