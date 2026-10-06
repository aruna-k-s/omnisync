import { ZERO_HASH, entryHash, hashBytes } from "@omnisync/crypto";
import type { NewUpdate } from "./types.js";

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

/** Programming errors in a batch are refused before anything is stored, in every store. */
export function validateBatch(updates: readonly NewUpdate[]): void {
  for (const u of updates) {
    if (u.payloadHash.length !== 32) throw new RangeError("payloadHash must be 32 bytes");
    if (u.certSerial !== undefined && u.certSerial.length !== 16) throw new RangeError("certSerial must be 16 bytes");
    if (u.receivedAtMs !== undefined && (!Number.isSafeInteger(u.receivedAtMs) || u.receivedAtMs < 0)) {
      throw new RangeError("receivedAtMs must be a safe non-negative integer");
    }
  }
}
