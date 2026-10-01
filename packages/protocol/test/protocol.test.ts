import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  FLAG_SIGNED,
  FrameError,
  FrameType,
  Keyring,
  decodeFrame,
  encodeFrame,
  encodeVarint,
  generateKeyPair,
  readVarint,
  signUpdate,
  verifyUpdate,
  type Frame,
} from "../src/index.js";

const seed = (n: number) => new Uint8Array(32).fill(n);
const alice = generateKeyPair(seed(1));
const mallory = generateKeyPair(seed(2));
const ring = new Keyring();
ring.add(alice.publicKey);

const safeUint = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });

describe("varint", () => {
  it("round-trips every safe integer", () => {
    fc.assert(
      fc.property(safeUint, (n) => {
        const bytes = encodeVarint(n);
        expect(readVarint(bytes, 0)).toEqual({ value: n, next: bytes.length });
      }),
    );
  });

  it("rejects truncated, non-minimal and negative input", () => {
    expect(() => readVarint(new Uint8Array([0x80]), 0)).toThrow(/truncated/);
    expect(() => readVarint(new Uint8Array([0x81, 0x00]), 0)).toThrow(/non-minimal/);
    expect(() => encodeVarint(-1)).toThrow();
    expect(() => encodeVarint(2 ** 53)).toThrow();
  });
});

describe("frame", () => {
  const unsignedType = fc.constantFrom(
    FrameType.SYNC_1,
    FrameType.SYNC_2,
    FrameType.AWARENESS,
    FrameType.ACK,
    FrameType.ERROR,
  );

  it("round-trips unsigned frames", () => {
    fc.assert(
      fc.property(unsignedType, safeUint, safeUint, fc.uint8Array({ maxLength: 512 }), (type, sessionId, seq, payload) => {
        const frame: Frame = { type, flags: 0, sessionId, seq, payload };
        expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
      }),
    );
  });

  it("refuses UPDATE frames without a signature", () => {
    const bytes = encodeFrame({ type: FrameType.ACK, flags: 0, sessionId: 1, seq: 1, payload: new Uint8Array() });
    bytes[2] = FrameType.UPDATE;
    expect(() => decodeFrame(bytes)).toThrow(FrameError);
  });

  it("rejects oversize payloads before reading them", () => {
    const bytes = encodeFrame({ type: FrameType.ACK, flags: 0, sessionId: 1, seq: 1, payload: new Uint8Array(100) });
    expect(() => decodeFrame(bytes, { maxPayloadBytes: 99 })).toThrow(/payload 100/);
  });

  it("never throws anything but FrameError on random bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
        try {
          decodeFrame(bytes);
        } catch (e) {
          expect(e).toBeInstanceOf(FrameError);
        }
      }),
    );
  });
});

describe("signed updates", () => {
  const sign = (payload: Uint8Array, docId = "doc-1") =>
    signUpdate({ docId, sessionId: 7, seq: 1, payload }, alice);

  it("verify accepts what sign produces", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), fc.string({ minLength: 1, maxLength: 40 }), (payload, docId) => {
        const result = verifyUpdate(sign(payload, docId), docId, ring.resolve);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.frame.payload).toEqual(payload);
          expect(result.frame.flags & FLAG_SIGNED).toBe(FLAG_SIGNED);
        }
      }),
      { numRuns: 50 },
    );
  });

  it("detects any single-bit flip", () => {
    const bytes = sign(new TextEncoder().encode("hello world"));
    fc.assert(
      fc.property(fc.integer({ min: 0, max: bytes.length * 8 - 1 }), (bit) => {
        const tampered = bytes.slice();
        tampered[bit >> 3] = (tampered[bit >> 3] as number) ^ (1 << (bit & 7));
        expect(verifyUpdate(tampered, "doc-1", ring.resolve).ok).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("binds the signature to the document", () => {
    expect(verifyUpdate(sign(new Uint8Array([1])), "doc-2", ring.resolve)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects unknown and revoked keys", () => {
    const fromMallory = signUpdate({ docId: "doc-1", sessionId: 1, seq: 1, payload: new Uint8Array([1]) }, mallory);
    expect(verifyUpdate(fromMallory, "doc-1", ring.resolve)).toEqual({ ok: false, reason: "unknown_key" });

    const temp = new Keyring();
    temp.add(alice.publicKey);
    temp.revoke(alice.keyId);
    expect(verifyUpdate(sign(new Uint8Array([1])), "doc-1", temp.resolve).ok).toBe(false);
  });

  it("rejects a valid signature replayed under another key id", () => {
    const bytes = sign(new Uint8Array([9]));
    const malloryRing = new Keyring();
    malloryRing.add(mallory.publicKey);
    // Point the key id at Mallory: the signature no longer matches.
    const keyIdOffset = bytes.length - 64 - 8;
    bytes.set(mallory.keyId, keyIdOffset);
    expect(verifyUpdate(bytes, "doc-1", malloryRing.resolve)).toEqual({ ok: false, reason: "bad_signature" });
  });
});
