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
const tenant = process.env["OMNISYNC_TENANT"];
if (!out || !url || !tenant) {
  process.stderr.write("usage: DATABASE_URL=... OMNISYNC_TENANT=<tenant> export <out.ndjson>\n");
  process.exit(2);
}
const docs = new PgDocumentStore({ connectionString: url, statementTimeoutMs: 60_000 });
// Exclusive create, owner-only: the file holds signed document updates and must not replace or leak into anything.
const file = createWriteStream(out, { flags: "wx", mode: 0o600 });
file.on("error", (e) => {
  process.stderr.write(`cannot write ${out}: ${e.message}\n`);
  process.exit(1);
});
try {
  const r = await exportLedger(
    { docs, identity: new PgIdentityStore(docs.pool), tenant },
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
