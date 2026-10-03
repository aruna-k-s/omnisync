/**
 * Production entry point: certificate authentication is mandatory, there is no static-key mode.
 *
 *   DATABASE_URL                 PostgreSQL (update log and identity tables; migrations run at startup)
 *   OMNISYNC_DATA_DIR            snapshot directory (S3 adapter arrives in week 9)
 *   OMNISYNC_ISSUER_PUBLIC_KEYS  comma separated hex Ed25519 public keys of trusted certificate issuers
 *   OMNISYNC_ALLOWED_ORIGINS     comma separated browser origins, or "*" (default none)
 *   PORT                         default 8080
 */
import { hexToBytes } from "@omnisync/protocol";
import { FsObjectStore, PgDocumentStore, PgIdentityStore, migrate } from "@omnisync/store";
import type { EngineName } from "@omnisync/engine";
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
const port = await gateway.listen();
console.warn(`gateway listening on :${port}`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void gateway.close().then(() => store.close()).then(() => process.exit(0));
  });
}
