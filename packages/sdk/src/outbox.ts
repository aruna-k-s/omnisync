/** One signed UPDATE frame waiting for the gateway to acknowledge it. */
export interface OutboxFrame {
  readonly sessionId: number;
  readonly seq: number;
  readonly bytes: Uint8Array;
  readonly claimedAtMs: number;
}

export interface Outbox {
  /** Stores frames in one atomic write. Throws if any (sessionId, seq) is already present with different bytes. */
  append(frames: readonly OutboxFrame[]): Promise<void>;
  /** Everything not yet acknowledged, in the order it was stored (seq order within a session). */
  pending(): Promise<OutboxFrame[]>;
  /** Removes an acknowledged frame. Unknown frames are a no-op. */
  ack(sessionId: number, seq: number): Promise<void>;
  /** The highest seq ever stored for this session (acknowledged or not), so numbering never restarts. 0 if none. */
  highestSeq(sessionId: number): Promise<number>;
  /** The last local copy of the document taken when nothing was waiting for the gateway, so a reload while offline still shows it. */
  loadSnapshot(): Promise<Uint8Array | undefined>;
  saveSnapshot(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function copy(f: OutboxFrame): OutboxFrame {
  return { sessionId: f.sessionId, seq: f.seq, bytes: f.bytes.slice(), claimedAtMs: f.claimedAtMs };
}

function check(frames: readonly OutboxFrame[]): void {
  const seen = new Set<string>();
  for (const f of frames) {
    if (!Number.isSafeInteger(f.sessionId) || f.sessionId < 0 || !Number.isSafeInteger(f.seq) || f.seq < 1) throw new RangeError("bad frame id");
    const k = `${f.sessionId}:${f.seq}`;
    if (seen.has(k)) throw new Error("the same (session, seq) appears twice in one append");
    seen.add(k);
  }
}

export class MemoryOutbox implements Outbox {
  readonly #frames = new Map<string, OutboxFrame>();
  readonly #highest = new Map<number, number>();

  append(frames: readonly OutboxFrame[]): Promise<void> {
    try {
      check(frames);
      const fresh: OutboxFrame[] = [];
      const high = new Map(this.#highest);
      for (const f of frames) {
        const prior = this.#frames.get(`${f.sessionId}:${f.seq}`);
        if (prior) {
          if (!same(prior.bytes, f.bytes)) throw new Error(`(${f.sessionId}, ${f.seq}) already stored with different bytes`);
          continue;
        }
        if (f.seq <= (high.get(f.sessionId) ?? 0)) throw new Error(`(${f.sessionId}, ${f.seq}) was stored and acknowledged before`);
        high.set(f.sessionId, f.seq);
        fresh.push(copy(f));
      }
      for (const f of fresh) {
        this.#frames.set(`${f.sessionId}:${f.seq}`, f);
        this.#highest.set(f.sessionId, Math.max(this.#highest.get(f.sessionId) ?? 0, f.seq));
      }
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  pending(): Promise<OutboxFrame[]> {
    return Promise.resolve([...this.#frames.values()].map(copy));
  }

  ack(sessionId: number, seq: number): Promise<void> {
    this.#frames.delete(`${sessionId}:${seq}`);
    return Promise.resolve();
  }

  highestSeq(sessionId: number): Promise<number> {
    return Promise.resolve(this.#highest.get(sessionId) ?? 0);
  }

  #snapshot: Uint8Array | undefined;
  loadSnapshot(): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.#snapshot?.slice());
  }
  saveSnapshot(bytes: Uint8Array): Promise<void> {
    this.#snapshot = bytes.slice();
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const FRAMES = "frames";
const META = "meta";
const SNAPSHOT = "snapshot";

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("indexeddb request failed"));
  });
}

interface StoredFrame {
  id?: number;
  sessionId: number;
  seq: number;
  bytes: Uint8Array;
  claimedAtMs: number;
}

/**
 * Durable outbox in IndexedDB. One database per document (name it with the device key and the document id).
 * `frames` holds unacknowledged frames in insertion order; `meta` remembers the highest seq per session so that
 * numbering survives acknowledgement and reloads.
 */
export class IndexedDbOutbox implements Outbox {
  readonly #name: string;
  readonly #idb: IDBFactory;
  #db: Promise<IDBDatabase> | undefined;

  constructor(opts: { name: string; indexedDB?: IDBFactory }) {
    this.#name = opts.name;
    this.#idb = opts.indexedDB ?? globalThis.indexedDB;
  }

  #open(): Promise<IDBDatabase> {
    this.#db ??= new Promise((resolve, reject) => {
      const req = this.#idb.open(this.#name, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        const frames = db.createObjectStore(FRAMES, { keyPath: "id", autoIncrement: true });
        frames.createIndex("bySeq", ["sessionId", "seq"], { unique: true });
        db.createObjectStore(META);
        db.createObjectStore(SNAPSHOT);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("cannot open outbox"));
    });
    return this.#db;
  }

  async append(frames: readonly OutboxFrame[]): Promise<void> {
    check(frames);
    const db = await this.#open();
    const tx = db.transaction([FRAMES, META], "readwrite");
    const store = tx.objectStore(FRAMES);
    const meta = tx.objectStore(META);
    const idx = store.index("bySeq");
    const outcome = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("outbox write failed"));
      tx.onabort = () => reject(tx.error ?? new Error("outbox write aborted"));
    });
    try {
      for (const f of frames) {
        const prior = (await request(idx.get([f.sessionId, f.seq]))) as StoredFrame | undefined;
        if (prior) {
          if (!same(prior.bytes, f.bytes)) throw new Error(`(${f.sessionId}, ${f.seq}) already stored with different bytes`);
          continue;
        }
        const high = ((await request(meta.get(f.sessionId))) as number | undefined) ?? 0;
        if (f.seq <= high) throw new Error(`(${f.sessionId}, ${f.seq}) was stored and acknowledged before`);
        store.add({ sessionId: f.sessionId, seq: f.seq, bytes: f.bytes.slice(), claimedAtMs: f.claimedAtMs });
        meta.put(f.seq, f.sessionId);
      }
    } catch (e) {
      try {
        tx.abort();
      } catch {
        /* already finished */
      }
      await outcome.catch(() => {});
      throw e instanceof Error ? e : new Error(String(e));
    }
    await outcome;
  }

  async pending(): Promise<OutboxFrame[]> {
    const db = await this.#open();
    const all = (await request(db.transaction(FRAMES, "readonly").objectStore(FRAMES).getAll())) as StoredFrame[];
    return all.map((f) => ({ sessionId: f.sessionId, seq: f.seq, bytes: new Uint8Array(f.bytes), claimedAtMs: f.claimedAtMs }));
  }

  async ack(sessionId: number, seq: number): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction(FRAMES, "readwrite");
    const store = tx.objectStore(FRAMES);
    const key = (await request(store.index("bySeq").getKey([sessionId, seq]))) as IDBValidKey | undefined;
    if (key !== undefined) store.delete(key);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("outbox ack failed"));
      tx.onabort = () => reject(tx.error ?? new Error("outbox ack aborted"));
    });
  }

  async highestSeq(sessionId: number): Promise<number> {
    const db = await this.#open();
    return ((await request(db.transaction(META, "readonly").objectStore(META).get(sessionId))) as number | undefined) ?? 0;
  }

  async loadSnapshot(): Promise<Uint8Array | undefined> {
    const db = await this.#open();
    const v = (await request(db.transaction(SNAPSHOT, "readonly").objectStore(SNAPSHOT).get("state"))) as Uint8Array | undefined;
    return v instanceof Uint8Array ? new Uint8Array(v) : undefined;
  }

  async saveSnapshot(bytes: Uint8Array): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction(SNAPSHOT, "readwrite");
    tx.objectStore(SNAPSHOT).put(bytes.slice(), "state");
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("snapshot write failed"));
      tx.onabort = () => reject(tx.error ?? new Error("snapshot write aborted"));
    });
  }

  async close(): Promise<void> {
    const db = await this.#db;
    db?.close();
    this.#db = undefined;
  }
}

/** A session id no stored frame has used, drawn at random (31 bits, so it fits every varint the wire uses). */
export async function newSessionId(outbox: Outbox, random: () => number = Math.random): Promise<number> {
  for (let i = 0; i < 16; i++) {
    const id = 1 + Math.floor(random() * (2 ** 31 - 1));
    if ((await outbox.highestSeq(id)) === 0) return id;
  }
  throw new Error("could not find an unused session id");
}
