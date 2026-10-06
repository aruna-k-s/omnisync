import { ZERO_HASH, byIdBytes, chainFields, validateBatch } from "./ledger.js";
import type {
  AppendResult,
  DocumentStore,
  LedgerStore,
  NewCheckpoint,
  NewSnapshot,
  NewUpdate,
  ObjectStore,
  PendingHead,
  SnapshotMeta,
  StoredCheckpoint,
  StoredUpdate,
} from "./types.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

interface DocState {
  headSeq: number;
  headHash: Uint8Array;
  checkpointSeq: number;
  updates: StoredUpdate[];
  /** key:session -> last client seq */
  sessions: Map<string, number>;
  stored: Set<string>;
  snapshots: SnapshotMeta[];
}

/** Reference implementation of DocumentStore. Same contract tests as Postgres. */
export class MemoryDocumentStore implements DocumentStore, LedgerStore {
  readonly #docs = new Map<string, DocState>();
  readonly #checkpoints: (StoredCheckpoint & { uploadedAtMs?: number; prevHash: Uint8Array })[] = [];

  /** Clock for entries that carry no receive time. Tests replace it. */
  now: () => number = Date.now;

  #doc(id: string): DocState {
    let d = this.#docs.get(id);
    if (!d) {
      d = { headSeq: 0, headHash: ZERO_HASH.slice(), checkpointSeq: 0, updates: [], sessions: new Map(), stored: new Set(), snapshots: [] };
      this.#docs.set(id, d);
    }
    return d;
  }

  async appendUpdates(documentId: string, updates: readonly NewUpdate[]): Promise<AppendResult[]> {
    validateBatch(updates);
    const d = this.#doc(documentId);
    return updates.map((u): AppendResult => {
      const sessionKey = `${hex(u.keyId)}:${u.sessionId}`;
      const last = d.sessions.get(sessionKey);
      if (last === undefined || u.clientSeq > last) {
        d.sessions.set(sessionKey, u.clientSeq);
        d.stored.add(`${sessionKey}:${u.clientSeq}`);
        const seq = d.headSeq + 1;
        const chain = chainFields(documentId, seq, d.headHash, u, this.now());
        d.headSeq = seq;
        d.headHash = chain.entryHash;
        d.updates.push({ seq, frame: u.frame.slice(), ...(u.certSerial ? { certSerial: u.certSerial.slice() } : {}), ...chain });
        return { status: "appended", seq, entryHash: chain.entryHash.slice() };
      }
      return d.stored.has(`${sessionKey}:${u.clientSeq}`) ? { status: "duplicate" } : { status: "replay" };
    });
  }

  async readUpdates(documentId: string, afterSeq: number, limit: number): Promise<StoredUpdate[]> {
    const d = this.#docs.get(documentId);
    if (!d) return [];
    return d.updates.filter((u) => u.seq > afterSeq).slice(0, limit).map(copyUpdate);
  }

  async headSeq(documentId: string): Promise<number> {
    return this.#docs.get(documentId)?.headSeq ?? 0;
  }

  async recordSnapshot(documentId: string, s: NewSnapshot): Promise<number> {
    const d = this.#doc(documentId);
    const version = (d.snapshots[0]?.version ?? 0) + 1;
    d.snapshots.unshift({ ...s, documentId, version });
    return version;
  }

  async listSnapshots(documentId: string, limit: number): Promise<SnapshotMeta[]> {
    return (this.#docs.get(documentId)?.snapshots ?? []).slice(0, limit);
  }

  // ----- LedgerStore ------------------------------------------------------

  async pendingHeads(limit: number): Promise<PendingHead[]> {
    return [...this.#docs.entries()]
      .filter(([, d]) => d.headSeq > d.checkpointSeq)
      .sort(([a], [b]) => byIdBytes(a, b))
      .slice(0, limit)
      .map(([documentId, d]) => ({ documentId, seq: d.headSeq, headHash: d.headHash.slice() }));
  }

  async pendingEntries(): Promise<number> {
    let n = 0;
    for (const d of this.#docs.values()) n += d.headSeq - d.checkpointSeq;
    return n;
  }

  async lastCheckpoint(): Promise<StoredCheckpoint | undefined> {
    const c = this.#checkpoints[this.#checkpoints.length - 1];
    return c ? publicCheckpoint(c) : undefined;
  }

  async reserveCheckpoint(cp: NewCheckpoint): Promise<boolean> {
    const last = this.#checkpoints[this.#checkpoints.length - 1];
    if (cp.n !== (last?.n ?? 0) + 1) return false;
    if (hex(cp.prevHash) !== hex(last?.hash ?? ZERO_HASH)) return false;
    for (const h of cp.heads) {
      const d = this.#docs.get(h.documentId);
      if (!d || h.seq > d.headSeq) return false;
    }
    for (const h of cp.heads) {
      const d = this.#docs.get(h.documentId) as DocState;
      d.checkpointSeq = Math.max(d.checkpointSeq, h.seq);
    }
    this.#checkpoints.push({ n: cp.n, createdAtMs: cp.createdAtMs, hash: cp.hash.slice(), bytes: cp.bytes.slice(), prevHash: cp.prevHash.slice() });
    return true;
  }

  async markCheckpointUploaded(n: number, atMs: number): Promise<void> {
    const c = this.#checkpoints[n - 1];
    if (c && c.uploadedAtMs === undefined) c.uploadedAtMs = atMs;
  }

  async unuploadedCheckpoints(limit: number): Promise<StoredCheckpoint[]> {
    return this.#checkpoints.filter((c) => c.uploadedAtMs === undefined).slice(0, limit).map(publicCheckpoint);
  }

  async listCheckpoints(afterN: number, limit: number): Promise<StoredCheckpoint[]> {
    return this.#checkpoints.filter((c) => c.n > afterN).slice(0, limit).map(publicCheckpoint);
  }

  async listDocuments(after: string | undefined, limit: number): Promise<string[]> {
    return [...this.#docs.keys()]
      .filter((id) => after === undefined || byIdBytes(id, after) > 0)
      .sort(byIdBytes)
      .slice(0, limit);
  }

  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

function copyUpdate(u: StoredUpdate): StoredUpdate {
  return {
    seq: u.seq,
    frame: u.frame.slice(),
    ...(u.certSerial ? { certSerial: u.certSerial.slice() } : {}),
    receivedAtMs: u.receivedAtMs,
    keyEpoch: u.keyEpoch,
    prevHash: u.prevHash.slice(),
    entryHash: u.entryHash.slice(),
    frameHash: u.frameHash.slice(),
    payloadHash: u.payloadHash.slice(),
  };
}

function publicCheckpoint(c: StoredCheckpoint): StoredCheckpoint {
  return {
    n: c.n,
    createdAtMs: c.createdAtMs,
    hash: c.hash.slice(),
    bytes: c.bytes.slice(),
    ...(c.uploadedAtMs !== undefined ? { uploadedAtMs: c.uploadedAtMs } : {}),
  };
}

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(key, bytes.slice());
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.objects.get(key)?.slice();
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}
