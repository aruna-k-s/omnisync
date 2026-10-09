import { FrameError } from "./frame.js";

/**
 * Size limits that are not part of the wire format.
 *
 * `decodeFrame`'s default cap (`DEFAULT_MAX_PAYLOAD_BYTES`, 1 MiB) is right for the frames a client *sends*: one edit.
 * The frame the gateway sends to a client that is catching up (SYNC_2) carries the whole difference between the two
 * states, so it is as large as the document. Clients decode what they receive from the gateway with this larger cap.
 * 64 MiB is the figure the gateway and the verifier already use for frames read back from storage.
 * See docs/specs/large-sync.md (ticket L1).
 */
export const MAX_INBOUND_PAYLOAD_BYTES = 64 * 1024 * 1024;

/** The cap a client applies to frames received from the gateway: its option if given and valid, else the maximum. */
export function resolveInboundCap(maxInboundBytes: number | undefined): number {
  if (maxInboundBytes === undefined) return MAX_INBOUND_PAYLOAD_BYTES;
  if (!Number.isInteger(maxInboundBytes) || maxInboundBytes < 1 || maxInboundBytes > MAX_INBOUND_PAYLOAD_BYTES) {
    throw new RangeError(`maxInboundBytes must be an integer between 1 and ${MAX_INBOUND_PAYLOAD_BYTES}`);
  }
  return maxInboundBytes;
}

/** A short description of why a received frame was dropped: the code and sizes, never any of its bytes. */
export function describeDecodeError(e: unknown): string {
  if (e instanceof FrameError) return `${e.code}: ${e.message}`;
  return "undecodable";
}
