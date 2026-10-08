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
 *   OMNISYNC_METRICS_PORT / OMNISYNC_METRICS_HOST   serve Prometheus /metrics on its own port (never PORT); host defaults to 127.0.0.1
 *   OMNISYNC_TRACES_ENABLED / OTEL_EXPORTER_OTLP_ENDPOINT / OMNISYNC_TRACE_SAMPLE_RATIO   "1" turns on sampled traces to an OTLP/HTTP collector
 *   PORT                         default 8080
 */
import { hexToBytes } from "@omnisync/protocol";
import { GatewayMetrics, Tracing, parseTelemetryConfig, setupTelemetry } from "@omnisync/telemetry";
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
const port0 = Number(process.env["PORT"] ?? 8080);
const telemetryConfig = parseTelemetryConfig(process.env, { appPort: port0 });
const storage = await openStorage(parseStorageConfig(process.env));
const store = new PgDocumentStore({ connectionString: need("DATABASE_URL") });
await migrate(store.pool);
const logLine = (event: string, fields?: Record<string, unknown>): void => console.warn(JSON.stringify({ event, ...fields }));
const telemetry = await setupTelemetry(telemetryConfig, { service: "omnisync-gateway", log: logLine });
const metrics = new GatewayMetrics(telemetry.meter);
const tracing = new Tracing(telemetry.tracer);
const origins = process.env["OMNISYNC_ALLOWED_ORIGINS"];
const gateway = new Gateway({
  engine: (process.env["OMNISYNC_ENGINE"] ?? "yjs") as EngineName,
  port: port0,
  host: "0.0.0.0",
  store,
  objects: storage.snapshots,
  auth: {
    issuers: need("OMNISYNC_ISSUER_PUBLIC_KEYS").split(",").map((h) => hexToBytes(h.trim())),
    identity: new PgIdentityStore(store.pool),
  },
  ...(origins ? { allowedOrigins: origins === "*" ? ("*" as const) : origins.split(",").map((s) => s.trim()) } : {}),
  log: logLine,
  metrics,
  tracing,
});
const checkpoints = new CheckpointWriter({
  store,
  objects: storage.checkpoints,
  tenant: ledger.tenant,
  signer: ledger.signer,
  log: logLine,
  tracing,
});
metrics.observeCheckpoints({ stats: () => checkpoints.stats, behindSeconds: () => checkpoints.behindMs() / 1000 });
checkpoints.start();
const port = await gateway.listen();
console.warn(`gateway listening on :${port}`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    // Drain editing first so the final checkpoint covers everything that was acknowledged.
    void gateway.close().then(() => checkpoints.stop({ flush: true })).then(() => telemetry.shutdown()).then(() => store.close()).then(() => process.exit(0));
  });
}
