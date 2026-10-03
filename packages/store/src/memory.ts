import type {
  AppendResult,
  DocumentStore,
  NewSnapshot,
  NewUpdate,
  ObjectStore,
  SnapshotMeta,
  StoredUpdate,
} from "./types.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

interface DocState {
  headSeq: number;
  updates: StoredUpdate[];
  /** key:session -> last client seq */
  sessions: Map<string, number>;
  stored: Set<string>;
  snapshots: SnapshotMeta[];
}

/** Reference implementation of DocumentStore. Same contract tests as Postgres. */
export class MemoryDocumentStore implements DocumentStore {
  readonly #docs = new Map<string, DocState>();

  #doc(id: string): DocState {
    let d = this.#docs.get(id);
    if (!d) {
      d = { headSeq: 0, updates: [], sessions: new Map(), stored: new Set(), snapshots: [] };
      this.#docs.set(id, d);
    }
    return d;
  }

  async appendUpdates(documentId: string, updates: readonly NewUpdate[]): Promise<AppendResult[]> {
    const d = this.#doc(documentId);
    return updates.map((u): AppendResult => {
      const sessionKey = `${hex(u.keyId)}:${u.sessionId}`;
      const last = d.sessions.get(sessionKey);
      if (last === undefined || u.clientSeq > last) {
        d.sessions.set(sessionKey, u.clientSeq);
        d.stored.add(`${sessionKey}:${u.clientSeq}`);
        const seq = ++d.headSeq;
        d.updates.push({ seq, frame: u.frame.slice(), ...(u.certSerial ? { certSerial: u.certSerial.slice() } : {}) });
        return { status: "appended", seq };
      }
      return d.stored.has(`${sessionKey}:${u.clientSeq}`) ? { status: "duplicate" } : { status: "replay" };
    });
  }

  async readUpdates(documentId: string, afterSeq: number, limit: number): Promise<StoredUpdate[]> {
    const d = this.#docs.get(documentId);
    if (!d) return [];
    return d.updates.filter((u) => u.seq > afterSeq).slice(0, limit).map((u) => ({ seq: u.seq, frame: u.frame.slice(), ...(u.certSerial ? { certSerial: u.certSerial.slice() } : {}) }));
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

  async ping(): Promise<void> {}
  async close(): Promise<void> {}
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
