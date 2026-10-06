import {
  MAX_CHECKPOINT_DOCS,
  MAX_TENANT_BYTES,
  ZERO_HASH,
  checkpointHash,
  checkpointObjectKey,
  signCheckpoint,
  verifyCheckpoint,
  type LedgerSigner,
} from "@omnisync/crypto";
import { byIdBytes, type LedgerStore, type ObjectStore } from "@omnisync/store";
import type { Log } from "./room.js";

/**
 * Signed checkpoints (spec: docs/specs/ledger.md). Reserve in the database first, then upload,
 * so the object store never holds two different objects for one n.
 */

export interface CheckpointWriterOptions {
  readonly store: LedgerStore;
  /** The locked bucket (Object Lock in compliance mode in production). */
  readonly objects: ObjectStore;
  readonly tenant: string;
  /** The ledger key. Never the certificate issuing key. */
  readonly signer: LedgerSigner;
  /** Write a checkpoint after this long if anything is pending (default 5 min). */
  readonly intervalMs?: number;
  /** ... or as soon as this many entries are pending (default 1,000). */
  readonly maxEntries?: number;
  /** Documents per checkpoint; more pending documents mean several checkpoints in a row (default 5,000). */
  readonly maxDocs?: number;
  /** How often `start()` checks the triggers (default 5 s). */
  readonly pollMs?: number;
  readonly objectTimeoutMs?: number;
  /** A signer that hangs (a KMS outage) must not stall the writer forever (default 10 s). */
  readonly signTimeoutMs?: number;
  readonly now?: () => number;
  readonly log?: Log;
}

export interface CheckpointStats {
  written: number;
  uploaded: number;
  /** Reservations lost to another writer. */
  conflicts: number;
  signFailures: number;
  storeFailures: number;
  uploadFailures: number;
  /** The object store already held different bytes under a number we reserved. Never overwritten; needs a human. */
  uploadConflicts: number;
  /** Receive-time ms of the newest checkpoint this process saw uploaded; 0 if none. */
  lastUploadedAtMs: number;
}

export class CheckpointWriter {
  readonly stats: CheckpointStats = { written: 0, uploaded: 0, conflicts: 0, signFailures: 0, storeFailures: 0, uploadFailures: 0, uploadConflicts: 0, lastUploadedAtMs: 0 };
  readonly #o: Required<Omit<CheckpointWriterOptions, "log">> & { log: Log };
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #lastRunAt: number;

  constructor(o: CheckpointWriterOptions) {
    this.#o = {
      intervalMs: 300_000,
      maxEntries: 1000,
      maxDocs: 5000,
      pollMs: 5000,
      objectTimeoutMs: 10_000,
      signTimeoutMs: 10_000,
      now: Date.now,
      log: () => {},
      ...o,
    } as Required<Omit<CheckpointWriterOptions, "log">> & { log: Log };
    const cfg = this.#o;
    const positive = (name: string, v: number, max = Number.MAX_SAFE_INTEGER): void => {
      if (!Number.isSafeInteger(v) || v < 1 || v > max) throw new RangeError(`${name} must be an integer between 1 and ${max}`);
    };
    positive("intervalMs", cfg.intervalMs);
    positive("maxEntries", cfg.maxEntries);
    positive("maxDocs", cfg.maxDocs, MAX_CHECKPOINT_DOCS);
    positive("pollMs", cfg.pollMs);
    positive("objectTimeoutMs", cfg.objectTimeoutMs);
    positive("signTimeoutMs", cfg.signTimeoutMs);
    const tenantBytes = Buffer.byteLength(cfg.tenant, "utf8");
    if (tenantBytes < 1 || tenantBytes > MAX_TENANT_BYTES || !isWellFormed(cfg.tenant)) throw new RangeError(`tenant must be 1-${MAX_TENANT_BYTES} bytes of well-formed Unicode`);
    if (Buffer.compare(cfg.signer.publicKey, Buffer.alloc(0)) === 0 || cfg.signer.keyId.length !== 8) throw new RangeError("signer needs an 8-byte key id and a public key");
    this.#lastRunAt = this.#o.now();
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.#o.pollMs);
    this.#timer.unref();
  }

  /** Stops the timer, waits for work in flight and, by default, writes what is pending. */
  async stop(opts: { flush: boolean } = { flush: true }): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
    if (opts.flush) await this.flush();
  }

  /** Writes a checkpoint if a trigger fired. Never throws. */
  async tick(): Promise<void> {
    if (this.#running) return this.#running;
    const run = (async () => {
      try {
        const pending = await this.#o.store.pendingEntries();
        const due = this.#o.now() - this.#lastRunAt >= this.#o.intervalMs;
        if (pending >= this.#o.maxEntries || (pending > 0 && due)) await this.#writeAll();
        else await this.#healUploads();
        if (pending === 0 && due) this.#lastRunAt = this.#o.now();
      } catch (e) {
        this.#storeFailure(e);
      }
    })();
    this.#running = run.finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  /** Writes everything pending now. Never throws. Resolves to the number of checkpoints written. */
  async flush(): Promise<number> {
    await this.#running;
    const before = this.stats.written;
    const run = this.#writeAll().catch((e) => this.#storeFailure(e));
    this.#running = run.finally(() => {
      this.#running = undefined;
    });
    await this.#running;
    return this.stats.written - before;
  }

  async #writeAll(): Promise<void> {
    // Never reserve a new number while an older one is not safely in the bucket: the next heal would find a gap.
    if (!(await this.#healUploads())) return;
    let conflicts = 0;
    for (;;) {
      const heads = (await this.#o.store.pendingHeads(this.#o.maxDocs)).sort((a, b) => byIdBytes(a.documentId, b.documentId));
      if (heads.length === 0) break;
      const last = await this.#o.store.lastCheckpoint();
      const n = (last?.n ?? 0) + 1;
      const prevHash = last?.hash ?? ZERO_HASH;
      // Checkpoint times never go backwards, even if the clock does.
      const createdAtMs = Math.max(this.#o.now(), last?.createdAtMs ?? 0);
      let bytes: Uint8Array;
      try {
        bytes = await withTimeout(
          Promise.resolve().then(() => signCheckpoint({ n, createdAtMs, prevCheckpointHash: prevHash, tenant: this.#o.tenant, heads }, this.#o.signer)),
          this.#o.signTimeoutMs,
          "checkpoint signing",
        );
        // Never reserve a number for bytes we have not checked ourselves: a broken signer would burn n for good.
        const own = verifyCheckpoint(bytes, (id) => (Buffer.compare(id, this.#o.signer.keyId) === 0 ? this.#o.signer.publicKey : undefined));
        if (!own.ok) throw new Error(`signer produced a checkpoint that does not verify (${own.reason})`);
      } catch (e) {
        this.stats.signFailures++;
        this.#o.log("checkpoint_sign_failed", { n, error: (e as Error).message });
        return;
      }
      const hash = checkpointHash(bytes);
      const reserved = await this.#o.store.reserveCheckpoint({ n, createdAtMs, prevHash, hash, bytes, heads });
      if (!reserved) {
        // Another writer took n. Re-read and try again, a few times.
        this.stats.conflicts++;
        if (++conflicts >= 3) return;
        continue;
      }
      this.stats.written++;
      this.#lastRunAt = this.#o.now();
      this.#o.log("checkpoint_reserved", { n, documents: heads.length });
      if (!(await this.#upload(n, bytes))) return; // leave it reserved; the next tick retries the same bytes
      if (heads.length < this.#o.maxDocs) break;
    }
  }

  /** True when nothing reserved is left waiting for its upload. */
  async #healUploads(): Promise<boolean> {
    for (const c of await this.#o.store.unuploadedCheckpoints(50)) {
      if (!(await this.#upload(c.n, c.bytes))) return false;
    }
    return true;
  }

  async #upload(n: number, bytes: Uint8Array): Promise<boolean> {
    try {
      const key = checkpointObjectKey(this.#o.tenant, n);
      const existing = await withTimeout(this.#o.objects.get(key), this.#o.objectTimeoutMs, "checkpoint lookup");
      if (existing !== undefined && Buffer.compare(existing, bytes) !== 0) {
        // Someone else wrote this number. Overwriting would destroy evidence; stop and let a human look.
        this.stats.uploadConflicts++;
        this.#o.log("checkpoint_upload_conflict", { n });
        return false;
      }
      if (existing === undefined) await withTimeout(this.#o.objects.put(key, bytes), this.#o.objectTimeoutMs, "checkpoint upload");
      await this.#o.store.markCheckpointUploaded(n, this.#o.now());
      this.stats.uploaded++;
      this.stats.lastUploadedAtMs = this.#o.now();
      return true;
    } catch (e) {
      this.stats.uploadFailures++;
      this.#o.log("checkpoint_upload_failed", { n, error: (e as Error).message });
      return false;
    }
  }

  #storeFailure(e: unknown): void {
    this.stats.storeFailures++;
    this.#o.log("checkpoint_store_failed", { error: (e as Error).message });
  }
}

function isWellFormed(s: string): boolean {
  return (s as string & { isWellFormed(): boolean }).isWellFormed();
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
