import { createHash } from "node:crypto";
import type { WebSocket } from "ws";
import type { EngineDoc, SyncEngine } from "@omnisync/engine";
import { decodeFrame, type Frame } from "@omnisync/protocol";
import {
  StoreUnavailableError,
  snapshotObjectKey,
  type DocumentStore,
  type ObjectStore,
  type SnapshotMeta,
} from "@omnisync/store";

/** Server-side replica identity inside every engine document. */
export const SERVER_ACTOR = 0xffff_fffe;
const REPLAY_PAGE = 1000;
const SNAPSHOT_CANDIDATES = 5;
const MAX_STORED_PAYLOAD = 64 * 1024 * 1024;

export interface RoomStats {
  persisted: number;
  duplicates: number;
  snapshots: number;
  snapshotFailures: number;
  snapshotFallbacks: number;
  poisonUpdates: number;
  loads: number;
}

export interface RoomConfig {
  compactEveryUpdates: number;
  maxBatch: number;
  /** Wait this long after a failed snapshot before trying again (ms). */
  compactRetryMs: number;
  /** Give up on one object-store or snapshot-metadata call after this long (ms). */
  objectTimeoutMs: number;
}

export type Log = (event: string, fields?: Record<string, unknown>) => void;

/** One verified UPDATE waiting to be made durable. Callbacks fire only after the outcome is final. */
export interface Submission {
  readonly frame: Frame;
  readonly bytes: Uint8Array;
  /** Committed and applied. `fresh` is false when this was a retry of an already stored update. */
  readonly accepted: (seq: number, fresh: boolean) => void;
  readonly rejected: (reason: string) => void;
}

export interface RoomDeps {
  readonly docId: string;
  readonly engine: SyncEngine;
  readonly store: DocumentStore;
  readonly objects: ObjectStore;
  readonly config: RoomConfig;
  readonly stats: RoomStats;
  readonly log: Log;
  /** Called with true after a store failure and false after the next success. */
  readonly onStoreHealth: (ok: boolean) => void;
}

/**
 * One in-memory document plus its durability machinery.
 *
 * Invariant: `doc` always equals the updates 1..headSeq of the log (minus
 * deterministically skipped poison updates). Apply and headSeq move in one
 * synchronous step, so a snapshot taken between awaits is a consistent cut.
 */
export class Room {
  doc!: EngineDoc;
  headSeq = 0;
  updatesSinceSnapshot = 0;
  lastSnapshotAt = Date.now();
  idleSince: number | undefined = Date.now();
  readonly clients = new Set<WebSocket>();
  readonly ready: Promise<void>;

  #pending: Submission[] = [];
  #draining = false;
  #compacting: Promise<void> | undefined;
  #compactNotBefore = 0;
  #destroyed = false;

  constructor(private readonly d: RoomDeps) {
    this.ready = this.#load();
  }

  get busy(): boolean {
    return this.#pending.length > 0 || this.#draining || this.#compacting !== undefined;
  }

  // ----- cold load -------------------------------------------------------

  async #load(): Promise<void> {
    const { store, objects, engine, docId, stats } = this.d;
    stats.loads++;
    const candidates = await store.listSnapshots(docId, SNAPSHOT_CANDIDATES);
    let base: SnapshotMeta | undefined;
    let doc: EngineDoc | undefined;
    for (const meta of candidates) {
      try {
        const bytes = await withTimeout(objects.get(meta.objectKey), this.d.config.objectTimeoutMs, "snapshot get");
        if (bytes === undefined) throw new Error("object missing");
        if (!equal(sha256(bytes), meta.sha256)) throw new Error("checksum mismatch");
        doc = engine.load(bytes, SERVER_ACTOR);
        base = meta;
        break;
      } catch (e) {
        stats.snapshotFallbacks++;
        this.d.log("snapshot_unusable", { docId, version: meta.version, reason: (e as Error).message });
      }
    }
    doc ??= engine.create(SERVER_ACTOR);
    this.doc = doc;

    let seq = base?.upToSeq ?? 0;
    let replayed = 0;
    for (;;) {
      const page = await store.readUpdates(docId, seq, REPLAY_PAGE);
      for (const u of page) {
        this.#applyStored(u.seq, u.frame);
        seq = u.seq;
        replayed++;
      }
      if (page.length < REPLAY_PAGE) break;
    }
    this.headSeq = seq;
    this.updatesSinceSnapshot = replayed;
    this.lastSnapshotAt = Date.now();
    this.d.log("room_loaded", { docId, snapshotVersion: base?.version ?? 0, replayed, headSeq: seq });
  }

  #applyStored(seq: number, bytes: Uint8Array): void {
    try {
      this.doc.applyUpdate(decodeFrame(bytes, { maxPayloadBytes: MAX_STORED_PAYLOAD }).payload);
    } catch (e) {
      // A signed but undecodable payload is part of the evidence log; skip it deterministically.
      this.d.stats.poisonUpdates++;
      this.d.log("poison_update_skipped", { docId: this.d.docId, seq, reason: (e as Error).message });
    }
  }

  // ----- write path ------------------------------------------------------

  submit(s: Submission): void {
    this.#pending.push(s);
    if (!this.#draining) void this.#drain();
  }

  async #drain(): Promise<void> {
    this.#draining = true;
    try {
      while (this.#pending.length > 0 && !this.#destroyed) {
        const batch = this.#pending.splice(0, this.d.config.maxBatch);
        await this.#commit(batch);
      }
    } finally {
      this.#draining = false;
    }
    this.#maybeCompact();
  }

  async #commit(batch: Submission[]): Promise<void> {
    const { store, docId, stats } = this.d;
    let results;
    try {
      results = await store.appendUpdates(
        docId,
        batch.map((s) => ({
          keyId: s.frame.keyId as Uint8Array,
          sessionId: s.frame.sessionId,
          clientSeq: s.frame.seq,
          frame: s.bytes,
        })),
      );
      this.d.onStoreHealth(true);
    } catch (e) {
      this.d.onStoreHealth(false);
      this.d.log("append_failed", { docId, batch: batch.length, error: (e as Error).message });
      const reason = e instanceof StoreUnavailableError ? "unavailable" : "internal";
      for (const s of batch) s.rejected(reason);
      return;
    }

    // Everything below is synchronous: applying and advancing headSeq form one step.
    const outcomes: (() => void)[] = [];
    batch.forEach((s, i) => {
      const r = results[i];
      if (r === undefined) return outcomes.push(() => s.rejected("internal"));
      if (r.status === "replay") return outcomes.push(() => s.rejected("replay"));
      if (r.status === "duplicate") {
        stats.duplicates++;
        return outcomes.push(() => s.accepted(0, false));
      }
      stats.persisted++;
      this.headSeq = r.seq;
      this.updatesSinceSnapshot++;
      try {
        this.doc.applyUpdate(s.frame.payload);
        outcomes.push(() => s.accepted(r.seq, true));
      } catch {
        // Persisted (it is signed evidence) but not applicable; load skips it the same way.
        stats.poisonUpdates++;
        outcomes.push(() => s.rejected("engine_rejected"));
      }
    });
    for (const fire of outcomes) fire();
  }

  // ----- compaction --------------------------------------------------------

  #maybeCompact(): void {
    if (this.updatesSinceSnapshot >= this.d.config.compactEveryUpdates) void this.compact();
  }

  /** Writes a snapshot of the current state. Never blocks editing and never throws. */
  compact(): Promise<void> {
    if (this.#compacting) return this.#compacting;
    if (this.updatesSinceSnapshot === 0 || this.#destroyed || Date.now() < this.#compactNotBefore) {
      return Promise.resolve();
    }
    // One synchronous capture: bytes and seq describe the same instant.
    const bytes = this.doc.snapshot();
    const stateVector = this.doc.encodeStateVector();
    const upToSeq = this.headSeq;
    const covered = this.updatesSinceSnapshot;
    const digest = sha256(bytes);

    const run = async () => {
      const { docId, objects, store, stats } = this.d;
      try {
        const objectKey = snapshotObjectKey(docId, upToSeq, Buffer.from(digest).toString("hex"));
        const limit = this.d.config.objectTimeoutMs;
        await withTimeout(objects.put(objectKey, bytes), limit, "snapshot put");
        const version = await withTimeout(
          store.recordSnapshot(docId, { objectKey, sha256: digest, upToSeq, stateVector, sizeBytes: bytes.length }),
          limit,
          "snapshot record",
        );
        stats.snapshots++;
        this.updatesSinceSnapshot = Math.max(0, this.updatesSinceSnapshot - covered);
        this.lastSnapshotAt = Date.now();
        this.d.log("snapshot_written", { docId, version, upToSeq, bytes: bytes.length });
      } catch (e) {
        stats.snapshotFailures++;
        this.#compactNotBefore = Date.now() + this.d.config.compactRetryMs;
        this.d.log("snapshot_failed", { docId, upToSeq, error: (e as Error).message });
      }
    };
    this.#compacting = run().finally(() => {
      this.#compacting = undefined;
    });
    return this.#compacting;
  }

  /** Test hook: lets a retry happen immediately after an injected snapshot failure. */
  resetCompactBackoff(): void {
    this.#compactNotBefore = 0;
  }

  /** Waits for queued writes and any compaction, then frees the engine document. */
  async destroy(opts: { finalSnapshot: boolean }): Promise<void> {
    while (this.busy) {
      if (this.#compacting) await this.#compacting;
      else await new Promise((r) => setTimeout(r, 2));
    }
    if (opts.finalSnapshot) await this.compact();
    this.#destroyed = true;
    this.doc.destroy();
  }
}

/** A hung dependency must never wedge eviction, shutdown or a cold load. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
}
