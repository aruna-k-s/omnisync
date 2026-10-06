import { encodeRecord, EXPORT_VERSION, type ExportRecord } from "@omnisync/verifier";
import type { DocumentStore, IdentityStore, LedgerStore } from "@omnisync/store";

/**
 * Streams a ledger export (spec: docs/specs/ledger.md): meta, certificates, checkpoints, then entries
 * document by document. Reads only; safe on a live database. For a checkpoint comparison against the
 * locked bucket, copy the bucket first and export afterwards.
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
  await emit({ t: "meta", version: EXPORT_VERSION, tenant: src.tenant, exportedAtMs: (src.now ?? Date.now)() });

  for (let after: Uint8Array | undefined; ; ) {
    const certs = await src.identity.listCertificates(after, PAGE);
    for (const c of certs) if (c.certificate) await emit({ t: "cert", serial: c.serial, certificate: c.certificate });
    const last = certs[certs.length - 1];
    if (certs.length < PAGE || !last) break;
    after = last.serial;
  }

  for (let after = 0; ; ) {
    const cps = await src.docs.listCheckpoints(after, PAGE);
    for (const c of cps) await emit({ t: "checkpoint", bytes: c.bytes });
    const last = cps[cps.length - 1];
    if (cps.length < PAGE || !last) break;
    after = last.n;
  }

  let entries = 0;
  let documents = 0;
  for (let cursor: string | undefined; ; ) {
    const ids = await src.docs.listDocuments(cursor, PAGE);
    for (const doc of ids) {
      documents++;
      for (let seq = 0; ; ) {
        const rows = await src.docs.readUpdates(doc, seq, PAGE);
        for (const r of rows) {
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
        if (rows.length < PAGE || !last) break;
        seq = last.seq;
      }
    }
    const lastId = ids[ids.length - 1];
    if (ids.length < PAGE || lastId === undefined) break;
    cursor = lastId;
  }
  return { entries, documents };
}
