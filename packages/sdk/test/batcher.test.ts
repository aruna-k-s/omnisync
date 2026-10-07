import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { Batcher } from "../src/batcher.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

function make(opts: { minMs?: number; maxMs?: number } = {}) {
  const flushes: { at: number; items: number[] }[] = [];
  const b = new Batcher<number>({
    ...opts,
    now: () => Date.now(),
    flush: (items) => {
      flushes.push({ at: Date.now(), items });
      return Promise.resolve();
    },
  });
  return { b, flushes };
}

describe("batching windows", () => {
  it("one edit flushes after the minimum window", async () => {
    const { b, flushes } = make();
    b.add(1);
    await vi.advanceTimersByTimeAsync(49);
    expect(flushes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(flushes).toEqual([{ at: 50, items: [1] }]);
  });

  it("edits inside the window join the same flush, in order, and restart the wait", async () => {
    const { b, flushes } = make();
    b.add(1);
    await vi.advanceTimersByTimeAsync(30);
    b.add(2);
    await vi.advanceTimersByTimeAsync(30);
    b.add(3);
    await vi.advanceTimersByTimeAsync(49);
    expect(flushes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(flushes).toEqual([{ at: 110, items: [1, 2, 3] }]);
  });

  it("a steady stream still flushes within the maximum window of its first edit", async () => {
    const { b, flushes } = make();
    for (let t = 0; t < 600; t += 20) {
      b.add(t);
      await vi.advanceTimersByTimeAsync(20);
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(flushes[0]!.at).toBe(250);
    // Each edit leaves within 250 ms of being made.
    for (const f of flushes) for (const t of f.items) expect(f.at - t).toBeLessThanOrEqual(250);
    expect(flushes.flatMap((f) => f.items)).toEqual(Array.from({ length: 30 }, (_, i) => i * 20));
  });

  it("flush() forces it and an empty flush does nothing", async () => {
    const { b, flushes } = make();
    await b.flush();
    expect(flushes).toHaveLength(0);
    b.add(1);
    await b.flush();
    expect(flushes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(flushes).toHaveLength(1); // the timer was cancelled
  });

  it("flushes never overlap, even when one is slow", async () => {
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const b = new Batcher<number>({
      flush: async (items) => {
        log.push(`start ${items}`);
        if (first) {
          first = false;
          await gate;
        }
        log.push(`end ${items}`);
      },
    });
    b.add(1);
    const p1 = b.flush();
    b.add(2);
    const p2 = b.flush();
    await vi.advanceTimersByTimeAsync(10);
    expect(log).toEqual(["start 1"]);
    release();
    await Promise.all([p1, p2]);
    expect(log).toEqual(["start 1", "end 1", "start 2", "end 2"]);
  });

  it("a failing flush is reported with its items and does not stop later flushes", async () => {
    const errors: [string, number[]][] = [];
    let n = 0;
    const b = new Batcher<number>({
      flush: () => (n++ === 0 ? Promise.reject(new Error("disk full")) : Promise.resolve()),
      onError: (e, items) => errors.push([e.message, items]),
    });
    b.add(1);
    await b.flush();
    b.add(2);
    await b.flush();
    expect(errors).toEqual([["disk full", [1]]]);
    expect(n).toBe(2);
  });

  it("rejects an impossible configuration", () => {
    expect(() => new Batcher({ minMs: 100, maxMs: 50, flush: () => Promise.resolve() })).toThrow(RangeError);
  });

  it("property: every edit is delivered exactly once, in order, and no wait exceeds the maximum", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 400 }), { minLength: 1, maxLength: 40 }), async (gaps) => {
        vi.setSystemTime(0);
        const t0 = Date.now();
        const edits: { id: number; at: number }[] = [];
        const seen: { id: number; at: number }[] = [];
        const b = new Batcher<number>({
          now: () => Date.now(),
          flush: (items) => {
            for (const id of items) seen.push({ id, at: Date.now() });
            return Promise.resolve();
          },
        });
        for (const [i, gap] of gaps.entries()) {
          await vi.advanceTimersByTimeAsync(gap);
          edits.push({ id: i, at: Date.now() });
          b.add(i);
        }
        await vi.advanceTimersByTimeAsync(300);
        expect(seen.map((s) => s.id)).toEqual(edits.map((e) => e.id));
        for (const [i, s] of seen.entries()) expect(s.at - edits[i]!.at).toBeLessThanOrEqual(250);
        expect(t0).toBe(0);
      }),
      { numRuns: 50 },
    );
  });
});
