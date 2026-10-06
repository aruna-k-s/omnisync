import { ZERO_HASH, checkpointHash, decodeCheckpoint, entryHash, hashBytes } from "@omnisync/crypto";
import type { NewCheckpoint, NewUpdate } from "./types.js";

/** Chain fields for one new entry. Shared by the memory and Postgres stores so they cannot disagree. */
export function chainFields(documentId: string, seq: number, prevHash: Uint8Array, u: NewUpdate, fallbackNowMs: number) {
  const receivedAtMs = u.receivedAtMs ?? fallbackNowMs;
  const frameHash = hashBytes(u.frame);
  const keyEpoch = 0;
  const hash = entryHash({
    documentId,
    seq,
    prevHash,
    receivedAtMs,
    keyEpoch,
    certSerial: u.certSerial,
    frameHash,
    payloadHash: u.payloadHash,
  });
  return { receivedAtMs, keyEpoch, frameHash, payloadHash: u.payloadHash.slice(), entryHash: hash, prevHash: prevHash.slice() };
}

export { ZERO_HASH };

/** UTF-8 byte order: the order checkpoints require. */
export const byIdBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

/**
 * Programming errors in a batch are refused before anything is stored, in every store.
 * The document id limits are the checkpoint encoding's: an id a checkpoint cannot carry would block every later checkpoint.
 */
export function validateBatch(documentId: string, updates: readonly NewUpdate[]): void {
  const idBytes = new TextEncoder().encode(documentId);
  if (idBytes.length < 1 || idBytes.length > 256 || new TextDecoder().decode(idBytes) !== documentId) {
    throw new RangeError("document id must be 1-256 bytes of well-formed Unicode");
  }
  for (const u of updates) {
    if (u.payloadHash.length !== 32) throw new RangeError("payloadHash must be 32 bytes");
    if (u.certSerial !== undefined && u.certSerial.length !== 16) throw new RangeError("certSerial must be 16 bytes");
    if (u.receivedAtMs !== undefined && (!Number.isSafeInteger(u.receivedAtMs) || u.receivedAtMs < 0)) {
      throw new RangeError("receivedAtMs must be a safe non-negative integer");
    }
  }
}

/**
 * The bytes of a checkpoint are what gets signed and uploaded; the fields next to them are what the database acts on.
 * They must say the same thing, or a bug in the writer would advance heads that the signed object does not attest.
 */
export function reservationIsConsistent(cp: NewCheckpoint): boolean {
  try {
    const d = decodeCheckpoint(cp.bytes);
    if (d.n !== cp.n || d.createdAtMs !== cp.createdAtMs) return false;
    if (Buffer.compare(d.prevCheckpointHash, cp.prevHash) !== 0) return false;
    if (Buffer.compare(checkpointHash(cp.bytes), cp.hash) !== 0) return false;
    if (d.heads.length !== cp.heads.length) return false;
    return d.heads.every((h, i) => {
      const c = cp.heads[i];
      return c !== undefined && h.documentId === c.documentId && h.seq === c.seq && Buffer.compare(h.headHash, c.headHash) === 0;
    });
  } catch {
    return false;
  }
}
