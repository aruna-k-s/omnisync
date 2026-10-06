/**
 * Writes a ledger export for `omnisync verify`.
 *
 *   DATABASE_URL=postgres://... OMNISYNC_TENANT=acme pnpm --filter @omnisync/gateway export ledger.ndjson
 */
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { PgDocumentStore, PgIdentityStore } from "@omnisync/store";
import { exportLedger } from "./export.js";

const out = process.argv[2];
const url = process.env["DATABASE_URL"];
if (!out || !url) {
  process.stderr.write("usage: DATABASE_URL=... [OMNISYNC_TENANT=default] export <out.ndjson>\n");
  process.exit(2);
}
const docs = new PgDocumentStore({ connectionString: url, statementTimeoutMs: 60_000 });
const file = createWriteStream(out);
try {
  const r = await exportLedger(
    { docs, identity: new PgIdentityStore(docs.pool), tenant: process.env["OMNISYNC_TENANT"] ?? "default" },
    async (line) => {
      if (!file.write(line)) await once(file, "drain");
    },
  );
  file.end();
  await once(file, "finish");
  process.stderr.write(`exported ${r.entries} entries from ${r.documents} documents to ${out}\n`);
} finally {
  await docs.close();
}
