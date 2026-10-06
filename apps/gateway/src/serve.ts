/**
 * Production entry point: certificate authentication is mandatory, there is no static-key mode.
 *
 *   DATABASE_URL                 PostgreSQL (update log and identity tables; migrations run at startup)
 *   OMNISYNC_DATA_DIR            snapshot directory (S3 adapter arrives in week 9)
 *   OMNISYNC_ISSUER_PUBLIC_KEYS  comma separated hex Ed25519 public keys of trusted certificate issuers
 *   OMNISYNC_ALLOWED_ORIGINS     comma separated browser origins, or "*" (default none)
 *   OMNISYNC_LEDGER_KEY_FILE     file holding the 32-byte ledger signing seed as 64 hex chars (NOT the issuing key)
 *   OMNISYNC_TENANT              tenant name written into checkpoints (default "default")
 *   OMNISYNC_CHECKPOINT_DIR      checkpoint directory; point it at the locked bucket mount (S3 adapter arrives in week 9)
 *   PORT                         default 8080
 */
import { readFile } from "node:fs/promises";
import { ledgerSignerFromKeyPair } from "@omnisync/crypto";
import { generateKeyPair, hexToBytes } from "@omnisync/protocol";
import { FsObjectStore, PgDocumentStore, PgIdentityStore, migrate } from "@omnisync/store";
import type { EngineName } from "@omnisync/engine";
import { CheckpointWriter } from "./checkpoint.js";
import { Gateway } from "./gateway.js";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
}

const store = new PgDocumentStore({ connectionString: need("DATABASE_URL") });
await migrate(store.pool);
const origins = process.env["OMNISYNC_ALLOWED_ORIGINS"];
const gateway = new Gateway({
  engine: (process.env["OMNISYNC_ENGINE"] ?? "yjs") as EngineName,
  port: Number(process.env["PORT"] ?? 8080),
  host: "0.0.0.0",
  store,
  objects: new FsObjectStore(process.env["OMNISYNC_DATA_DIR"] ?? "./.omnisync-data"),
  auth: {
    issuers: need("OMNISYNC_ISSUER_PUBLIC_KEYS").split(",").map((h) => hexToBytes(h.trim())),
    identity: new PgIdentityStore(store.pool),
  },
  ...(origins ? { allowedOrigins: origins === "*" ? ("*" as const) : origins.split(",").map((s) => s.trim()) } : {}),
  log: (event, fields) => console.warn(JSON.stringify({ event, ...fields })),
});
const seedHex = (await readFile(need("OMNISYNC_LEDGER_KEY_FILE"), "utf8")).trim();
if (!/^[0-9a-f]{64}$/.test(seedHex)) throw new Error("OMNISYNC_LEDGER_KEY_FILE must hold 64 lowercase hex characters");
const ledgerKey = generateKeyPair(hexToBytes(seedHex));
const issuerKeys = need("OMNISYNC_ISSUER_PUBLIC_KEYS").split(",").map((h) => h.trim().toLowerCase());
if (issuerKeys.includes(Buffer.from(ledgerKey.publicKey).toString("hex"))) {
  throw new Error("the ledger key must not be a certificate issuing key");
}
const checkpoints = new CheckpointWriter({
  store,
  objects: new FsObjectStore(process.env["OMNISYNC_CHECKPOINT_DIR"] ?? "./.omnisync-checkpoints"),
  tenant: process.env["OMNISYNC_TENANT"] ?? "default",
  signer: ledgerSignerFromKeyPair(ledgerKey),
  log: (event, fields) => console.warn(JSON.stringify({ event, ...fields })),
});
checkpoints.start();
const port = await gateway.listen();
console.warn(`gateway listening on :${port}`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    // Drain editing first so the final checkpoint covers everything that was acknowledged.
    void gateway.close().then(() => checkpoints.stop({ flush: true })).then(() => store.close()).then(() => process.exit(0));
  });
}
