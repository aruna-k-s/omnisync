import { readVarint, varintSize, writeVarint } from "./varint.js";

/**
 * Wire frame (spec: docs/specs/envelope.md)
 *
 * | magic 1B | version 1B | type 1B | flags 1B | session id varint | seq varint |
 * | payload length varint | payload | key id 8B | signature 64B |
 *
 * The key id and signature trailer is present only when FLAG_SIGNED is set,
 * and it is required for UPDATE frames.
 */

export const MAGIC = 0x4f; // "O"
export const PROTOCOL_VERSION = 1;
export const KEY_ID_BYTES = 8;
export const SIGNATURE_BYTES = 64;
export const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;

export const FrameType = {
  SYNC_1: 1, // state vector
  SYNC_2: 2, // missing updates
  UPDATE: 3, // signed edit batch
  AWARENESS: 4, // presence, unsigned, never stored
  ACK: 5,
  ERROR: 6,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

export const FLAG_SIGNED = 0b0000_0001;
const KNOWN_FLAGS = FLAG_SIGNED;

export interface Frame {
  readonly type: FrameType;
  readonly flags: number;
  readonly sessionId: number;
  readonly seq: number;
  readonly payload: Uint8Array;
  /** Present only on signed frames. */
  readonly keyId?: Uint8Array;
  /** Present only on signed frames. */
  readonly signature?: Uint8Array;
}

export class FrameError extends Error {
  override readonly name = "FrameError";
  constructor(
    readonly code:
      | "bad_magic"
      | "bad_version"
      | "bad_type"
      | "bad_flags"
      | "too_large"
      | "truncated"
      | "trailing_bytes"
      | "unsigned_update"
      | "bad_trailer",
    message: string,
  ) {
    super(message);
  }
}

const VALID_TYPES = new Set<number>(Object.values(FrameType));

export interface DecodeOptions {
  maxPayloadBytes?: number;
}

/** Bytes of a frame up to and including the key id: the part a signature covers. */
export function encodeUnsignedPart(frame: Omit<Frame, "signature">): Uint8Array {
  validateShape(frame);
  const signed = (frame.flags & FLAG_SIGNED) !== 0;
  const headerLen =
    4 + varintSize(frame.sessionId) + varintSize(frame.seq) + varintSize(frame.payload.length);
  const out = new Uint8Array(headerLen + frame.payload.length + (signed ? KEY_ID_BYTES : 0));
  out[0] = MAGIC;
  out[1] = PROTOCOL_VERSION;
  out[2] = frame.type;
  out[3] = frame.flags;
  let o = 4;
  o = writeVarint(out, o, frame.sessionId);
  o = writeVarint(out, o, frame.seq);
  o = writeVarint(out, o, frame.payload.length);
  out.set(frame.payload, o);
  o += frame.payload.length;
  if (signed) out.set(frame.keyId as Uint8Array, o);
  return out;
}

export function encodeFrame(frame: Frame): Uint8Array {
  const head = encodeUnsignedPart(frame);
  if ((frame.flags & FLAG_SIGNED) === 0) return head;
  if (frame.signature?.length !== SIGNATURE_BYTES) {
    throw new FrameError("bad_trailer", "signed frame needs a 64-byte signature");
  }
  const out = new Uint8Array(head.length + SIGNATURE_BYTES);
  out.set(head, 0);
  out.set(frame.signature as Uint8Array, head.length);
  return out;
}

export function decodeFrame(input: Uint8Array, opts: DecodeOptions = {}): Frame {
  const maxPayload = opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  if (input.length < 4) throw new FrameError("truncated", "frame shorter than fixed header");
  if (input[0] !== MAGIC) throw new FrameError("bad_magic", "bad magic byte");
  if (input[1] !== PROTOCOL_VERSION) throw new FrameError("bad_version", `unsupported version ${input[1]}`);
  const type = input[2] as number;
  if (!VALID_TYPES.has(type)) throw new FrameError("bad_type", `unknown frame type ${type}`);
  const flags = input[3] as number;
  if ((flags & ~KNOWN_FLAGS) !== 0) throw new FrameError("bad_flags", `unknown flags ${flags}`);

  let sessionId: number, seq: number, payloadLen: number, o: number;
  try {
    ({ value: sessionId, next: o } = readVarint(input, 4));
    ({ value: seq, next: o } = readVarint(input, o));
    ({ value: payloadLen, next: o } = readVarint(input, o));
  } catch (e) {
    throw new FrameError("truncated", (e as Error).message);
  }
  if (payloadLen > maxPayload) throw new FrameError("too_large", `payload ${payloadLen} > ${maxPayload}`);

  const signed = (flags & FLAG_SIGNED) !== 0;
  const trailer = signed ? KEY_ID_BYTES + SIGNATURE_BYTES : 0;
  const expected = o + payloadLen + trailer;
  if (input.length < expected) throw new FrameError("truncated", "frame shorter than declared length");
  if (input.length > expected) throw new FrameError("trailing_bytes", "bytes after end of frame");
  if (type === FrameType.UPDATE && !signed) throw new FrameError("unsigned_update", "UPDATE frames must be signed");

  // Copy so callers can never alias the network buffer.
  const payload = input.slice(o, o + payloadLen);
  o += payloadLen;
  const base = { type: type as FrameType, flags, sessionId, seq, payload };
  if (!signed) return base;
  return {
    ...base,
    keyId: input.slice(o, o + KEY_ID_BYTES),
    signature: input.slice(o + KEY_ID_BYTES, o + trailer),
  };
}

function validateShape(frame: Omit<Frame, "signature"> & { signature?: Uint8Array }): void {
  if (!VALID_TYPES.has(frame.type)) throw new FrameError("bad_type", `unknown frame type ${frame.type}`);
  if ((frame.flags & ~KNOWN_FLAGS) !== 0 || frame.flags < 0 || frame.flags > 0xff) {
    throw new FrameError("bad_flags", `unknown flags ${frame.flags}`);
  }
  const signed = (frame.flags & FLAG_SIGNED) !== 0;
  if (frame.type === FrameType.UPDATE && !signed) {
    throw new FrameError("unsigned_update", "UPDATE frames must be signed");
  }
  if (signed) {
    if (frame.keyId?.length !== KEY_ID_BYTES) throw new FrameError("bad_trailer", "key id must be 8 bytes");
    if (frame.signature !== undefined && frame.signature.length !== SIGNATURE_BYTES) {
      throw new FrameError("bad_trailer", "signature must be 64 bytes");
    }
  }
}
