/**
 * Storage boundaries for the gateway. The update log is the source of truth;
 * snapshots are a cache that bounds load time (spec: docs/specs/gateway-core.md).
 */

export interface NewUpdate {
  readonly keyId: Uint8Array;
  readonly sessionId: number;
  /** Client-assigned sequence; must increase per (key, session). */
  readonly clientSeq: number;
  /** The complete signed frame, byte for byte. */
  readonly frame: Uint8Array;
  /** Serial of the certificate the signer authenticated with (16 bytes). Absent for unauthenticated test setups. */
  readonly certSerial?: Uint8Array;
  /** SHA-256 of the payload bytes as stored (today the frame payload). Chained into the ledger entry. */
  readonly payloadHash: Uint8Array;
  /** Gateway receive time. Defaults to the store's clock; the gateway passes its own so tests control it. */
  readonly receivedAtMs?: number;
}

export type AppendResult =
  /** Committed at this per-document sequence number. */
  | { readonly status: "appended"; readonly seq: number; readonly entryHash: Uint8Array }
  /** Same signer, session and client seq is already stored: safe to ACK again. */
  | { readonly status: "duplicate" }
  /** Client seq is not above the high-water mark and was never stored: reject. */
  | { readonly status: "replay" };

/** One ledger entry: the signed frame plus the chain fields set when it was appended. */
export interface StoredUpdate {
  readonly seq: number;
  readonly frame: Uint8Array;
  readonly certSerial?: Uint8Array;
  readonly receivedAtMs: number;
  readonly keyEpoch: number;
  readonly prevHash: Uint8Array;
  readonly entryHash: Uint8Array;
  readonly frameHash: Uint8Array;
  readonly payloadHash: Uint8Array;
}

export interface SnapshotMeta {
  readonly documentId: string;
  readonly version: number;
  readonly objectKey: string;
  readonly sha256: Uint8Array;
  /** The snapshot contains exactly the updates with seq <= upToSeq. */
  readonly upToSeq: number;
  readonly stateVector: Uint8Array;
  readonly sizeBytes: number;
}

export type NewSnapshot = Omit<SnapshotMeta, "documentId" | "version">;

export class StoreUnavailableError extends Error {
  override readonly name = "StoreUnavailableError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export interface DocumentStore {
  /**
   * Appends a batch in one transaction, in order. Nothing is visible until
   * the whole batch commits; on error nothing in it was stored and the call
   * throws StoreUnavailableError.
   */
  appendUpdates(documentId: string, updates: readonly NewUpdate[]): Promise<AppendResult[]>;

  /** Updates with seq > afterSeq in ascending seq order, at most `limit`. */
  readUpdates(documentId: string, afterSeq: number, limit: number): Promise<StoredUpdate[]>;

  /** Highest assigned seq, or 0 for an unknown document. */
  headSeq(documentId: string): Promise<number>;

  /** Registers a snapshot whose bytes are already in object storage. Returns the new version. */
  recordSnapshot(documentId: string, snapshot: NewSnapshot): Promise<number>;

  /** Newest first. */
  listSnapshots(documentId: string, limit: number): Promise<SnapshotMeta[]>;

  /** Resolves if the store can serve requests, otherwise throws. */
  ping(): Promise<void>;

  close(): Promise<void>;
}

/** A document whose head moved since the last checkpoint covered it. */
export interface PendingHead {
  readonly documentId: string;
  readonly seq: number;
  readonly headHash: Uint8Array;
}

export interface StoredCheckpoint {
  readonly n: number;
  readonly createdAtMs: number;
  readonly hash: Uint8Array;
  /** The whole signed object. */
  readonly bytes: Uint8Array;
  readonly uploadedAtMs?: number;
}

export interface NewCheckpoint {
  readonly n: number;
  readonly createdAtMs: number;
  /** Must equal the hash of checkpoint n-1 (zeros for n = 1) or the reservation is refused. */
  readonly prevHash: Uint8Array;
  readonly hash: Uint8Array;
  readonly bytes: Uint8Array;
  /** Heads the checkpoint attests; each document's checkpoint_seq advances to its seq. */
  readonly heads: readonly PendingHead[];
}

/** Checkpoint bookkeeping and export access (spec: docs/specs/ledger.md). */
export interface LedgerStore {
  /** Documents with entries newer than their last checkpoint, ascending by id bytes, at most `limit`. */
  pendingHeads(limit: number): Promise<PendingHead[]>;
  /** Total entries not yet covered by any checkpoint. */
  pendingEntries(): Promise<number>;
  lastCheckpoint(): Promise<StoredCheckpoint | undefined>;
  /**
   * Reserves checkpoint n and advances the covered heads in one transaction.
   * Returns false, changing nothing, if n is not exactly last+1, the previous hash differs,
   * or a head is ahead of the log (another writer won, or a bug).
   */
  reserveCheckpoint(cp: NewCheckpoint): Promise<boolean>;
  markCheckpointUploaded(n: number, atMs: number): Promise<void>;
  /** Reserved but not yet uploaded, oldest first. */
  unuploadedCheckpoints(limit: number): Promise<StoredCheckpoint[]>;
  /** Ascending n, n > afterN. */
  listCheckpoints(afterN: number, limit: number): Promise<StoredCheckpoint[]>;
  /** Ascending id bytes, id strictly greater than `after` when given. */
  listDocuments(after: string | undefined, limit: number): Promise<string[]>;
}

export interface ObjectStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  /**
   * Writes only when nothing is stored under `key`: true = created, false = something was already there and is left
   * untouched. Atomic across concurrent callers (and, for shared backends, across processes).
   */
  putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean>;
  /** Returns undefined when the object does not exist. */
  get(key: string): Promise<Uint8Array | undefined>;
  delete(key: string): Promise<void>;
}

/**
 * Content-addressed so the name is known before the metadata row exists and a
 * retried upload is idempotent. The document id is hex-encoded so any id is a
 * safe path segment.
 */
export function snapshotObjectKey(documentId: string, upToSeq: number, sha256Hex: string): string {
  const doc = Buffer.from(documentId, "utf8").toString("hex");
  return `snapshots/${doc}/${String(upToSeq).padStart(12, "0")}-${sha256Hex.slice(0, 16)}.bin`;
}
