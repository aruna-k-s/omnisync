import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { MAX_TENANT_BYTES, ledgerSignerFromKeyPair, type LedgerSigner } from "@omnisync/crypto";
import { bytesToHex, generateKeyPair, hexToBytes } from "@omnisync/protocol";

/** What the production entry point needs to write checkpoints. Everything is checked before the gateway listens. */
export interface LedgerConfig {
  readonly signer: LedgerSigner;
  readonly tenant: string;
  readonly checkpointDir: string;
}

/**
 * Reads and validates the ledger settings. Throws with a message that names the variable, never one that
 * contains key material. Pure apart from reading the key file.
 */
export async function loadLedgerConfig(env: Record<string, string | undefined>, issuersHex: readonly string[]): Promise<LedgerConfig> {
  const need = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`missing environment variable ${name}`);
    return v;
  };
  const tenant = need("OMNISYNC_TENANT");
  if (Buffer.byteLength(tenant, "utf8") > MAX_TENANT_BYTES || !(tenant as string & { isWellFormed(): boolean }).isWellFormed()) {
    throw new Error(`OMNISYNC_TENANT must be 1-${MAX_TENANT_BYTES} bytes of well-formed text`);
  }
  const checkpointDir = resolve(need("OMNISYNC_CHECKPOINT_DIR"));
  const dataDir = env["OMNISYNC_DATA_DIR"];
  if (dataDir !== undefined && resolve(dataDir) === checkpointDir) {
    throw new Error("OMNISYNC_CHECKPOINT_DIR must not be the snapshot directory: checkpoints belong in the locked bucket");
  }

  const keyFile = need("OMNISYNC_LEDGER_KEY_FILE");
  const info = await stat(keyFile).catch(() => {
    throw new Error("OMNISYNC_LEDGER_KEY_FILE cannot be read");
  });
  if (!info.isFile()) throw new Error("OMNISYNC_LEDGER_KEY_FILE must be a regular file");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error("OMNISYNC_LEDGER_KEY_FILE must not be readable by group or others (chmod 600)");
  }
  const seedHex = (await readFile(keyFile, "utf8")).trim();
  if (!/^[0-9a-f]{64}$/.test(seedHex)) throw new Error("OMNISYNC_LEDGER_KEY_FILE must hold 64 lowercase hex characters");
  const key = generateKeyPair(hexToBytes(seedHex));
  const publicHex = bytesToHex(key.publicKey);
  if (issuersHex.some((h) => h.trim().toLowerCase() === publicHex)) {
    throw new Error("the ledger key must not be a certificate issuing key");
  }
  return { signer: ledgerSignerFromKeyPair(key), tenant, checkpointDir };
}
