import pg from "pg";
import {
  StoreUnavailableError,
  type AppendResult,
  type DocumentStore,
  type NewSnapshot,
  type NewUpdate,
  type SnapshotMeta,
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
export class PgDocumentStore implements DocumentStore {
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
    return this.#tx(async (c) => {
      await c.query("INSERT INTO documents (id) VALUES ($1) ON CONFLICT DO NOTHING", [documentId]);
      // The row lock serialises writers of one document and allocates gapless seqs.
      const head = await c.query<{ head_seq: string }>("SELECT head_seq FROM documents WHERE id = $1 FOR UPDATE", [
        documentId,
      ]);
      let seq = Number(head.rows[0]?.head_seq ?? 0);
      const start = seq;
      const results: AppendResult[] = [];
      for (const u of updates) {
        const keyId = buf(u.keyId);
        // One statement: advance the replay high-water mark and, only if it advanced, insert the row.
        const r = await c.query(
          `WITH hw AS (
             INSERT INTO update_sessions (document_id, key_id, session_id, last_seq)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (document_id, key_id, session_id)
             DO UPDATE SET last_seq = EXCLUDED.last_seq WHERE update_sessions.last_seq < EXCLUDED.last_seq
             RETURNING 1)
           INSERT INTO document_updates (document_id, seq, key_id, session_id, client_seq, frame)
           SELECT $1, $5, $2, $3, $4, $6 FROM hw`,
          [documentId, keyId, u.sessionId, u.clientSeq, seq + 1, buf(u.frame)],
        );
        if (r.rowCount === 1) {
          seq++;
          results.push({ status: "appended", seq });
          continue;
        }
        const existing = await c.query(
          "SELECT 1 FROM document_updates WHERE document_id = $1 AND key_id = $2 AND session_id = $3 AND client_seq = $4",
          [documentId, keyId, u.sessionId, u.clientSeq],
        );
        results.push({ status: existing.rowCount === 1 ? "duplicate" : "replay" });
      }
      if (seq !== start) await c.query("UPDATE documents SET head_seq = $2 WHERE id = $1", [documentId, seq]);
      return results;
    });
  }

  async readUpdates(documentId: string, afterSeq: number, limit: number): Promise<StoredUpdate[]> {
    const r = await this.#query<{ seq: string; frame: Buffer }>(
      "SELECT seq, frame FROM document_updates WHERE document_id = $1 AND seq > $2 ORDER BY seq LIMIT $3",
      [documentId, afterSeq, limit],
    );
    return r.rows.map((row) => ({ seq: Number(row.seq), frame: toBytes(row.frame) }));
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

function wrap(e: unknown): StoreUnavailableError {
  if (e instanceof StoreUnavailableError) return e;
  return new StoreUnavailableError(`postgres: ${(e as Error).message}`, { cause: e });
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) throw new Error(`invalid schema name: ${name}`);
  return name;
}
