import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_PAYLOAD_BYTES, FrameType, FrameError, MAX_INBOUND_PAYLOAD_BYTES, decodeFrame, encodeFrame, resolveInboundCap } from "../src/index.js";

const frameWith = (n: number) => encodeFrame({ type: FrameType.SYNC_2, flags: 0, sessionId: 0, seq: 0, payload: new Uint8Array(n) });

describe("inbound payload cap (ticket L1, docs/specs/large-sync.md)", () => {
  it("is 64 MiB, the figure the gateway and verifier already use for stored frames, and above the default", () => {
    expect(MAX_INBOUND_PAYLOAD_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_INBOUND_PAYLOAD_BYTES).toBeGreaterThan(DEFAULT_MAX_PAYLOAD_BYTES);
    expect(DEFAULT_MAX_PAYLOAD_BYTES).toBe(1024 * 1024); // frame.ts is unchanged: edits stay capped at 1 MiB
  });

  it("decodeFrame refuses 1 MiB + 1 by default and accepts it with the inbound cap", () => {
    const bytes = frameWith(DEFAULT_MAX_PAYLOAD_BYTES + 1);
    expect(() => decodeFrame(bytes)).toThrow(FrameError);
    expect(decodeFrame(bytes, { maxPayloadBytes: MAX_INBOUND_PAYLOAD_BYTES }).payload.length).toBe(DEFAULT_MAX_PAYLOAD_BYTES + 1);
  });

  it("the inbound cap itself is a limit: one byte over it is refused", () => {
    const bytes = frameWith(MAX_INBOUND_PAYLOAD_BYTES + 1);
    expect(() => decodeFrame(bytes, { maxPayloadBytes: MAX_INBOUND_PAYLOAD_BYTES })).toThrow(/too_large|payload/);
  });

  it("resolveInboundCap: the maximum is allowed, one over is not, and so on", () => {
    expect(resolveInboundCap(undefined)).toBe(MAX_INBOUND_PAYLOAD_BYTES);
    expect(resolveInboundCap(MAX_INBOUND_PAYLOAD_BYTES)).toBe(MAX_INBOUND_PAYLOAD_BYTES);
    expect(resolveInboundCap(1)).toBe(1);
    for (const bad of [MAX_INBOUND_PAYLOAD_BYTES + 1, 0, -5, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => resolveInboundCap(bad)).toThrow(RangeError);
  });
});
