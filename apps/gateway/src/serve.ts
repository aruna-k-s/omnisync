/**
 * Production entry point: certificate authentication is mandatory, there is no static-key mode.
 *
 *   DATABASE_URL                 PostgreSQL (update log and identity tables; migrations run at startup)
 *   OMNISYNC_DATA_DIR            snapshot directory (or OMNISYNC_SNAPSHOT_S3_BUCKET, not both)
 *   OMNISYNC_ISSUER_PUBLIC_KEYS  comma separated hex Ed25519 public keys of trusted certificate issuers
 *   OMNISYNC_ALLOWED_ORIGINS     comma separated browser origins, or "*" (default none)
 *   OMNISYNC_LEDGER_KEY_FILE     file holding the 32-byte ledger signing seed as 64 hex chars (NOT the issuing key)
 *   OMNISYNC_TENANT              tenant name written into checkpoints (required; verifiers check it with --tenant)
 *   OMNISYNC_CHECKPOINT_DIR      checkpoint directory, or OMNISYNC_CHECKPOINT_S3_BUCKET (exactly one is required)
 *   OMNISYNC_CHECKPOINT_RETAIN_DAYS / OMNISYNC_CHECKPOINT_LOCK_MODE   with a checkpoint bucket: days to keep each checkpoint locked
 *                                (required, 1-36500) and COMPLIANCE (default) or GOVERNANCE
 *   OMNISYNC_S3_ENDPOINT / OMNISYNC_S3_REGION / OMNISYNC_S3_PATH_STYLE   S3 endpoint (MinIO), region (default us-east-1), 1 for path-style
 *                                credentials come from the AWS SDK's usual environment (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, web identity)
 *   PORT                         default 8080
 */
import { hexToBytes } from "@omnisync/protocol";
import { PgDocumentStore, PgIdentityStore, migrate } from "@omnisync/store";
import type { EngineName } from "@omnisync/engine";
import { CheckpointWriter } from "./checkpoint.js";
import { Gateway } from "./gateway.js";
import { loadLedgerConfig } from "./ledger-config.js";
import { openStorage, parseStorageConfig } from "./storage-config.js";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
}

// Every setting is checked before the first connection or listener, so a bad deployment fails at start, not at the first checkpoint.
const issuerKeys = need("OMNISYNC_ISSUER_PUBLIC_KEYS").split(",").map((h) => h.trim().toLowerCase());
const ledger = await loadLedgerConfig(process.env, issuerKeys);
const storage = await openStorage(parseStorageConfig(process.env));
const store = new PgDocumentStore({ connectionString: need("DATABASE_URL") });
await migrate(store.pool);
const origins = process.env["OMNISYNC_ALLOWED_ORIGINS"];
const gateway = new Gateway({
  engine: (process.env["OMNISYNC_ENGINE"] ?? "yjs") as EngineName,
  port: Number(process.env["PORT"] ?? 8080),
  host: "0.0.0.0",
  store,
  objects: storage.snapshots,
  auth: {
    issuers: need("OMNISYNC_ISSUER_PUBLIC_KEYS").split(",").map((h) => hexToBytes(h.trim())),
    identity: new PgIdentityStore(store.pool),
  },
  ...(origins ? { allowedOrigins: origins === "*" ? ("*" as const) : origins.split(",").map((s) => s.trim()) } : {}),
  log: (event, fields) => console.warn(JSON.stringify({ event, ...fields })),
});
const checkpoints = new CheckpointWriter({
  store,
  objects: storage.checkpoints,
  tenant: ledger.tenant,
  signer: ledger.signer,
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
