import { encodeRecord, EXPORT_VERSION, type ExportRecord } from "@omnisync/verifier";
import type { DocumentStore, IdentityStore, LedgerStore } from "@omnisync/store";

/**
 * Streams a ledger export (spec: docs/specs/ledger.md): meta, certificates, checkpoints, then entries
 * document by document. Reads only; safe on a live database: the file is a consistent snapshot of the moment
 * the heads were captured. For a checkpoint comparison against the locked bucket, copy the bucket first and
 * export afterwards.
 */
export interface ExportSources {
  readonly docs: DocumentStore & LedgerStore;
  readonly identity: IdentityStore;
  readonly tenant: string;
  readonly now?: () => number;
}

const PAGE = 1000;

export async function exportLedger(src: ExportSources, write: (line: string) => void | Promise<void>): Promise<{ entries: number; documents: number }> {
  const emit = async (r: ExportRecord): Promise<void> => {
    await write(encodeRecord(r) + "\n");
  };

  // Capture first, then read, so a database that keeps taking writes still yields a consistent file:
  // 1. the newest checkpoint number, 2. every document's head at that moment, 3. certificates (all of which
  // were stored before any entry that uses them), 4. checkpoints up to the cap, 5. entries up to each head.
  // Anything written after step 2 simply is not in the export; the next export has it.
  const checkpointCap = (await src.docs.lastCheckpoint())?.n ?? 0;
  const heads: { doc: string; head: number }[] = [];
  for (let cursor: string | undefined; ; ) {
    const ids = await src.docs.listDocuments(cursor, PAGE);
    for (const doc of ids) {
      const head = await src.docs.headSeq(doc);
      if (head > 0) heads.push({ doc, head });
    }
    const lastId = ids[ids.length - 1];
    if (ids.length < PAGE || lastId === undefined) break;
    cursor = lastId;
  }

  await emit({ t: "meta", version: EXPORT_VERSION, tenant: src.tenant, exportedAtMs: (src.now ?? Date.now)() });

  for (let after: Uint8Array | undefined; ; ) {
    const certs = await src.identity.listCertificates(after, PAGE);
    for (const c of certs) if (c.certificate) await emit({ t: "cert", serial: c.serial, certificate: c.certificate });
    const last = certs[certs.length - 1];
    if (certs.length < PAGE || !last) break;
    after = last.serial;
  }

  for (let after = 0; after < checkpointCap; ) {
    const cps = await src.docs.listCheckpoints(after, Math.min(PAGE, checkpointCap - after));
    for (const c of cps) if (c.n <= checkpointCap) await emit({ t: "checkpoint", bytes: c.bytes });
    const last = cps[cps.length - 1];
    if (!last) break;
    after = last.n;
  }

  let entries = 0;
  for (const { doc, head } of heads) {
    for (let seq = 0; seq < head; ) {
      const rows = await src.docs.readUpdates(doc, seq, Math.min(PAGE, head - seq));
      for (const r of rows) {
        if (r.seq > head) break;
        entries++;
        await emit({
          t: "entry",
          doc,
          seq: r.seq,
          receivedAtMs: r.receivedAtMs,
          ...(r.certSerial ? { certSerial: r.certSerial } : {}),
          keyEpoch: r.keyEpoch,
          prevHash: r.prevHash,
          entryHash: r.entryHash,
          frameHash: r.frameHash,
          payloadHash: r.payloadHash,
          frame: r.frame,
        });
      }
      const last = rows[rows.length - 1];
      if (!last) break;
      seq = last.seq;
    }
  }
  return { entries, documents: heads.length };
}
