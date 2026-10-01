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
}

export type AppendResult =
  /** Committed at this per-document sequence number. */
  | { readonly status: "appended"; readonly seq: number }
  /** Same signer, session and client seq is already stored: safe to ACK again. */
  | { readonly status: "duplicate" }
  /** Client seq is not above the high-water mark and was never stored: reject. */
  | { readonly status: "replay" };

export interface StoredUpdate {
  readonly seq: number;
  readonly frame: Uint8Array;
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

export interface ObjectStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
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
