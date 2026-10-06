import pg from "pg";
import { ZERO_HASH, chainFields, reservationIsConsistent, validateBatch } from "./ledger.js";
import {
  StoreUnavailableError,
  type AppendResult,
  type DocumentStore,
  type LedgerStore,
  type NewCheckpoint,
  type NewSnapshot,
  type NewUpdate,
  type PendingHead,
  type SnapshotMeta,
  type StoredCheckpoint,
  type StoredUpdate,
} from "./types.js";

export interface PgStoreOptions {
  connectionString: string;
  /** Run every statement in this schema. Tests use one schema per test file. */
  schema?: string;
  maxConnections?: number;
  /** Fail a statement instead of hanging forever (ms). */
  statementTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

const toBytes = (b: Buffer): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice();
const buf = (b: Uint8Array): Buffer => Buffer.from(b.buffer, b.byteOffset, b.byteLength);

/**
 * PostgreSQL DocumentStore. Every storage failure surfaces as
 * StoreUnavailableError so the gateway refuses writes it cannot record
 * (spec: "PostgreSQL unavailable").
 */
export class PgDocumentStore implements DocumentStore, LedgerStore {
  readonly pool: pg.Pool;

  constructor(opts: PgStoreOptions) {
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: opts.maxConnections ?? 10,
      connectionTimeoutMillis: opts.connectionTimeoutMs ?? 3000,
      statement_timeout: opts.statementTimeoutMs ?? 5000,
      ...(opts.schema ? { options: `-c search_path=${quoteIdent(opts.schema)}` } : {}),
    });
    // An idle client can be dropped by the server; that must not crash the process.
    this.pool.on("error", () => {});
  }

  async appendUpdates(documentId: string, updates: readonly NewUpdate[]): Promise<AppendResult[]> {
    if (updates.length === 0) return [];
    validateBatch(documentId, updates);
    const nowMs = Date.now();
    return this.#tx(async (c) => {
      await c.query("INSERT INTO documents (id) VALUES ($1) ON CONFLICT DO NOTHING", [documentId]);
      // The row lock serialises writers of one document, allocates gapless seqs and fixes the chain's previous hash.
      const head = await c.query<{ head_seq: string; head_hash: Buffer }>(
        "SELECT head_seq, head_hash FROM documents WHERE id = $1 FOR UPDATE",
        [documentId],
      );
      let seq = Number(head.rows[0]?.head_seq ?? 0);
      let headHash = head.rows[0] ? toBytes(head.rows[0].head_hash) : ZERO_HASH.slice();
      const start = seq;
      const results: AppendResult[] = [];
      for (const u of updates) {
        const keyId = buf(u.keyId);
        const chain = chainFields(documentId, seq + 1, headHash, u, nowMs);
        // One statement: advance the replay high-water mark and, only if it advanced, insert the row.
        const r = await c.query(
          `WITH hw AS (
             INSERT INTO update_sessions (document_id, key_id, session_id, last_seq)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (document_id, key_id, session_id)
             DO UPDATE SET last_seq = EXCLUDED.last_seq WHERE update_sessions.last_seq < EXCLUDED.last_seq
             RETURNING 1)
           INSERT INTO document_updates
             (document_id, seq, key_id, session_id, client_seq, frame, cert_serial,
              received_at_ms, key_epoch, prev_hash, entry_hash, frame_hash, payload_hash)
           SELECT $1, $5, $2, $3, $4, $6, $7, $8, $9, $10, $11, $12, $13 FROM hw`,
          [
            documentId, keyId, u.sessionId, u.clientSeq, seq + 1, buf(u.frame), u.certSerial ? buf(u.certSerial) : null,
            chain.receivedAtMs, chain.keyEpoch, buf(chain.prevHash), buf(chain.entryHash), buf(chain.frameHash), buf(chain.payloadHash),
          ],
        );
        if (r.rowCount === 1) {
          seq++;
          headHash = chain.entryHash;
          results.push({ status: "appended", seq, entryHash: chain.entryHash.slice() });
          continue;
        }
        const existing = await c.query(
          "SELECT 1 FROM document_updates WHERE document_id = $1 AND key_id = $2 AND session_id = $3 AND client_seq = $4",
          [documentId, keyId, u.sessionId, u.clientSeq],
        );
        results.push({ status: existing.rowCount === 1 ? "duplicate" : "replay" });
      }
      if (seq !== start) await c.query("UPDATE documents SET head_seq = $2, head_hash = $3 WHERE id = $1", [documentId, seq, buf(headHash)]);
      return results;
    });
  }

  async readUpdates(documentId: string, afterSeq: number, limit: number): Promise<StoredUpdate[]> {
    const r = await this.#query<{
      seq: string;
      frame: Buffer;
      cert_serial: Buffer | null;
      received_at_ms: string;
      key_epoch: number;
      prev_hash: Buffer;
      entry_hash: Buffer;
      frame_hash: Buffer;
      payload_hash: Buffer;
    }>(
      `SELECT seq, frame, cert_serial, received_at_ms, key_epoch, prev_hash, entry_hash, frame_hash, payload_hash
         FROM document_updates WHERE document_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [documentId, afterSeq, limit],
    );
    return r.rows.map((row) => ({
      seq: Number(row.seq),
      frame: toBytes(row.frame),
      ...(row.cert_serial ? { certSerial: toBytes(row.cert_serial) } : {}),
      receivedAtMs: Number(row.received_at_ms),
      keyEpoch: row.key_epoch,
      prevHash: toBytes(row.prev_hash),
      entryHash: toBytes(row.entry_hash),
      frameHash: toBytes(row.frame_hash),
      payloadHash: toBytes(row.payload_hash),
    }));
  }

  async headSeq(documentId: string): Promise<number> {
    const r = await this.#query<{ head_seq: string }>("SELECT head_seq FROM documents WHERE id = $1", [documentId]);
    return Number(r.rows[0]?.head_seq ?? 0);
  }

  async recordSnapshot(documentId: string, s: NewSnapshot): Promise<number> {
    return this.#tx(async (c) => {
      await c.query("INSERT INTO documents (id) VALUES ($1) ON CONFLICT DO NOTHING", [documentId]);
      const r = await c.query<{ version: number }>(
        `INSERT INTO snapshots (document_id, version, object_key, sha256, up_to_seq, state_vector, size_bytes)
         SELECT $1, COALESCE(MAX(version), 0) + 1, $2, $3, $4, $5, $6 FROM snapshots WHERE document_id = $1
         RETURNING version`,
        [documentId, s.objectKey, buf(s.sha256), s.upToSeq, buf(s.stateVector), s.sizeBytes],
      );
      return (r.rows[0] as { version: number }).version;
    });
  }

  async listSnapshots(documentId: string, limit: number): Promise<SnapshotMeta[]> {
    const r = await this.#query<{
      version: number;
      object_key: string;
      sha256: Buffer;
      up_to_seq: string;
      state_vector: Buffer;
      size_bytes: number;
    }>(
      `SELECT version, object_key, sha256, up_to_seq, state_vector, size_bytes
         FROM snapshots WHERE document_id = $1 ORDER BY version DESC LIMIT $2`,
      [documentId, limit],
    );
    return r.rows.map((row) => ({
      documentId,
      version: row.version,
      objectKey: row.object_key,
      sha256: toBytes(row.sha256),
      upToSeq: Number(row.up_to_seq),
      stateVector: toBytes(row.state_vector),
      sizeBytes: row.size_bytes,
    }));
  }

  // ----- LedgerStore ------------------------------------------------------

  async pendingHeads(limit: number): Promise<PendingHead[]> {
    const r = await this.#query<{ id: string; head_seq: string; head_hash: Buffer }>(
      `SELECT id, head_seq, head_hash FROM documents WHERE head_seq > checkpoint_seq
        ORDER BY id COLLATE "C" LIMIT $1`,
      [limit],
    );
    return r.rows.map((row) => ({ documentId: row.id, seq: Number(row.head_seq), headHash: toBytes(row.head_hash) }));
  }

  async pendingEntries(): Promise<number> {
    const r = await this.#query<{ n: string }>("SELECT COALESCE(SUM(head_seq - checkpoint_seq), 0) AS n FROM documents", []);
    return Number(r.rows[0]?.n ?? 0);
  }

  async lastCheckpoint(): Promise<StoredCheckpoint | undefined> {
    const r = await this.#query<CheckpointRow>(CHECKPOINT_SELECT + " ORDER BY c.n DESC LIMIT 1", []);
    return r.rows[0] ? checkpointOf(r.rows[0]) : undefined;
  }

  async reserveCheckpoint(cp: NewCheckpoint): Promise<boolean> {
    return this.#tx(async (c) => {
      // One reservation at a time; the second writer re-reads the new last checkpoint and refuses.
      await c.query("SELECT pg_advisory_xact_lock($1)", [CHECKPOINT_LOCK]);
      const last = await c.query<{ n: string; checkpoint_hash: Buffer; created_at_ms: string }>(
        "SELECT n, checkpoint_hash, created_at_ms FROM ledger_checkpoints ORDER BY n DESC LIMIT 1",
      );
      const lastN = Number(last.rows[0]?.n ?? 0);
      const lastHash = last.rows[0] ? toBytes(last.rows[0].checkpoint_hash) : ZERO_HASH;
      if (cp.n !== lastN + 1 || !buf(cp.prevHash).equals(buf(lastHash))) return false;
      if (cp.heads.length === 0 || !reservationIsConsistent(cp)) return false; // a checkpoint attests something, and says what the row says
      if (last.rows[0] && cp.createdAtMs < Number(last.rows[0].created_at_ms)) return false;
      const ids = cp.heads.map((h) => h.documentId);
      const seqs = cp.heads.map((h) => h.seq);
      const hashes = cp.heads.map((h) => buf(h.headHash));
      // Every head must move strictly forward, stay within the log and be the real entry's hash. A stale read
      // (another writer already covered it) is refused here, under the lock, so no checkpoint repeats or regresses a head.
      const ok = await c.query(
        `SELECT count(*)::int AS n
           FROM unnest($1::text[], $2::bigint[], $3::bytea[]) AS v(id, seq, hash)
           JOIN documents d ON d.id = v.id AND v.seq <= d.head_seq AND v.seq > d.checkpoint_seq
           JOIN document_updates u ON u.document_id = v.id AND u.seq = v.seq AND u.entry_hash = v.hash`,
        [ids, seqs, hashes],
      );
      if ((ok.rows[0] as { n: number }).n !== cp.heads.length) return false;
      await c.query(
        `UPDATE documents d SET checkpoint_seq = GREATEST(d.checkpoint_seq, v.seq)
           FROM unnest($1::text[], $2::bigint[]) AS v(id, seq) WHERE d.id = v.id`,
        [ids, seqs],
      );

      await c.query("INSERT INTO ledger_checkpoints (n, created_at_ms, checkpoint_hash, bytes) VALUES ($1, $2, $3, $4)", [
        cp.n,
        cp.createdAtMs,
        buf(cp.hash),
        buf(cp.bytes),
      ]);
      return true;
    });
  }

  async markCheckpointUploaded(n: number, atMs: number): Promise<void> {
    await this.#query("INSERT INTO ledger_checkpoint_uploads (n, uploaded_at_ms) VALUES ($1, $2) ON CONFLICT DO NOTHING", [n, atMs]);
  }

  async unuploadedCheckpoints(limit: number): Promise<StoredCheckpoint[]> {
    const r = await this.#query<CheckpointRow>(CHECKPOINT_SELECT + " WHERE u.n IS NULL ORDER BY c.n LIMIT $1", [limit]);
    return r.rows.map(checkpointOf);
  }

  async listCheckpoints(afterN: number, limit: number): Promise<StoredCheckpoint[]> {
    const r = await this.#query<CheckpointRow>(CHECKPOINT_SELECT + " WHERE c.n > $1 ORDER BY c.n LIMIT $2", [afterN, limit]);
    return r.rows.map(checkpointOf);
  }

  async listDocuments(after: string | undefined, limit: number): Promise<string[]> {
    const r = await this.#query<{ id: string }>(
      `SELECT id FROM documents WHERE ($1::text IS NULL OR id COLLATE "C" > $1::text COLLATE "C") ORDER BY id COLLATE "C" LIMIT $2`,
      [after ?? null, limit],
    );
    return r.rows.map((row) => row.id);
  }

  async ping(): Promise<void> {
    await this.#query("SELECT 1", []);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async #query<R extends pg.QueryResultRow>(text: string, values: unknown[]): Promise<pg.QueryResult<R>> {
    try {
      return await this.pool.query<R>(text, values);
    } catch (e) {
      throw wrap(e);
    }
  }

  async #tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch (e) {
      throw wrap(e);
    }
    let broken = false;
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        broken = true; // connection is gone; do not return it to the pool
      }
      throw wrap(e);
    } finally {
      client.release(broken || undefined);
    }
  }
}

// Arbitrary constant, distinct from the migration lock.
const CHECKPOINT_LOCK = 7_040_212;

interface CheckpointRow {
  n: string;
  created_at_ms: string;
  checkpoint_hash: Buffer;
  bytes: Buffer;
  uploaded_at_ms: string | null;
}
const CHECKPOINT_SELECT = `SELECT c.n, c.created_at_ms, c.checkpoint_hash, c.bytes, u.uploaded_at_ms
  FROM ledger_checkpoints c LEFT JOIN ledger_checkpoint_uploads u ON u.n = c.n`;
const checkpointOf = (r: CheckpointRow): StoredCheckpoint => ({
  n: Number(r.n),
  createdAtMs: Number(r.created_at_ms),
  hash: toBytes(r.checkpoint_hash),
  bytes: toBytes(r.bytes),
  ...(r.uploaded_at_ms !== null ? { uploadedAtMs: Number(r.uploaded_at_ms) } : {}),
});

function wrap(e: unknown): StoreUnavailableError {
  if (e instanceof StoreUnavailableError) return e;
  return new StoreUnavailableError(`postgres: ${(e as Error).message}`, { cause: e });
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) throw new Error(`invalid schema name: ${name}`);
  return name;
}
