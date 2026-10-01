import {
  StoreUnavailableError,
  type AppendResult,
  type DocumentStore,
  type NewSnapshot,
  type NewUpdate,
  type ObjectStore,
  type SnapshotMeta,
  type StoredUpdate,
} from "./types.js";

/**
 * Fault injection for tests and chaos drills: wraps a real store and makes
 * calls fail on demand, like a database that is down or an object store that
 * is timing out.
 */
export class FaultyDocumentStore implements DocumentStore {
  /** While true every call fails. */
  down = false;
  /** Fail the next N calls, then recover. */
  failNext = 0;
  /** Added latency per call (ms). */
  delayMs = 0;
  calls = 0;

  constructor(readonly inner: DocumentStore) {}

  async #gate(): Promise<void> {
    this.calls++;
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.down || this.failNext > 0) {
      if (this.failNext > 0) this.failNext--;
      throw new StoreUnavailableError("injected fault");
    }
  }

  async appendUpdates(id: string, u: readonly NewUpdate[]): Promise<AppendResult[]> {
    await this.#gate();
    return this.inner.appendUpdates(id, u);
  }
  async readUpdates(id: string, after: number, limit: number): Promise<StoredUpdate[]> {
    await this.#gate();
    return this.inner.readUpdates(id, after, limit);
  }
  async headSeq(id: string): Promise<number> {
    await this.#gate();
    return this.inner.headSeq(id);
  }
  async recordSnapshot(id: string, s: NewSnapshot): Promise<number> {
    await this.#gate();
    return this.inner.recordSnapshot(id, s);
  }
  async listSnapshots(id: string, limit: number): Promise<SnapshotMeta[]> {
    await this.#gate();
    return this.inner.listSnapshots(id, limit);
  }
  async ping(): Promise<void> {
    await this.#gate();
    return this.inner.ping();
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}

export class FaultyObjectStore implements ObjectStore {
  down = false;
  /** Keys whose next get() returns these bytes instead (simulates corruption). */
  corrupt = new Map<string, Uint8Array>();

  constructor(readonly inner: ObjectStore) {}

  async put(key: string, bytes: Uint8Array): Promise<void> {
    if (this.down) throw new Error("injected object store outage");
    return this.inner.put(key, bytes);
  }
  async get(key: string): Promise<Uint8Array | undefined> {
    if (this.down) throw new Error("injected object store outage");
    return this.corrupt.get(key) ?? this.inner.get(key);
  }
  async delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }
}
