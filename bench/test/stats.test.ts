import { describe, expect, it } from "vitest";
import { dropWarmup, percentile, poissonGaps, summarize, verdict } from "../src/load/stats.js";

describe("percentile (nearest rank)", () => {
  it("returns the ceil(p/100 * n)th smallest value", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(95);
    expect(percentile(xs, 99)).toBe(99);
    expect(percentile(xs, 100)).toBe(100);
    expect(percentile(xs, 1)).toBe(1);
  });
  it("does not need sorted input and does not modify it", () => {
    const xs = [9, 1, 5, 3, 7];
    expect(percentile(xs, 50)).toBe(5);
    expect(xs).toEqual([9, 1, 5, 3, 7]);
  });
  it("handles one sample, two samples and ties", () => {
    expect(percentile([4], 99)).toBe(4);
    expect(percentile([1, 2], 50)).toBe(1);
    expect(percentile([1, 2], 51)).toBe(2);
    expect(percentile([5, 5, 5, 9], 75)).toBe(5);
    expect(percentile([5, 5, 5, 9], 76)).toBe(9);
  });
  it("rounds up, so the 99th of 150 samples is the 149th, not the 148th", () => {
    const xs = Array.from({ length: 150 }, (_, i) => i + 1);
    expect(percentile(xs, 99)).toBe(149);
  });
  it("refuses an empty list, a percentile outside 0..100 and non-finite samples", () => {
    expect(() => percentile([], 50)).toThrow(/no samples/);
    expect(() => percentile([1], -1)).toThrow(/percentile/);
    expect(() => percentile([1], 100.5)).toThrow(/percentile/);
    expect(() => percentile([1, Number.NaN], 50)).toThrow(/finite/);
    expect(() => percentile([1, Number.POSITIVE_INFINITY], 50)).toThrow(/finite/);
  });
});

describe("summarize", () => {
  it("reports count, min, p50, p95, p99 and max", () => {
    const s = summarize(Array.from({ length: 200 }, (_, i) => (i + 1) / 10));
    expect(s).toEqual({ count: 200, min: 0.1, p50: 10, p95: 19, p99: 19.8, max: 20 });
  });
  it("refuses no samples rather than reporting zeros", () => {
    expect(() => summarize([])).toThrow(/no samples/);
  });
  it("rounds to three decimals for reporting", () => {
    expect(summarize([1 / 3]).p50).toBe(0.333);
  });
});

describe("dropWarmup", () => {
  const samples = (n: number) => Array.from({ length: n }, (_, i) => ({ at: i * 100, ms: i }));
  it("drops samples taken before the warm-up has passed, by time since the first sample", () => {
    const out = dropWarmup(samples(100), 0.1, 0);
    expect(out[0]?.at).toBe(1000);
    expect(out).toHaveLength(90);
  });
  it("uses at least the minimum warm-up when 10% of the run is shorter", () => {
    const out = dropWarmup(samples(100), 0.1, 3000);
    expect(out[0]?.at).toBe(3000);
    expect(out).toHaveLength(70);
  });
  it("measures the warm-up from the first sample, not from zero", () => {
    const late = Array.from({ length: 100 }, (_, i) => ({ at: 50_000 + i * 100, ms: i }));
    const out = dropWarmup(late, 0.1, 0);
    expect(out[0]?.at).toBe(51_000);
    expect(out).toHaveLength(90);
    expect(dropWarmup(late, 0, 2000)[0]?.at).toBe(52_000);
  });
  it("keeps the sample exactly at the boundary", () => {
    expect(dropWarmup([{ at: 0, ms: 1 }, { at: 1000, ms: 2 }], 0, 1000)).toEqual([{ at: 1000, ms: 2 }]);
  });
  it("refuses to drop everything", () => {
    expect(() => dropWarmup(samples(10), 0.1, 100_000)).toThrow(/warm-up/);
  });
});

describe("verdict", () => {
  const t = { limit: 100, unit: "ms" } as const;
  it("is met at or under the limit and missed over it", () => {
    expect(verdict(99.9, t, { generatorLoopP99Ms: 1 })).toBe("met");
    expect(verdict(100, t, { generatorLoopP99Ms: 1 })).toBe("met");
    expect(verdict(100.1, t, { generatorLoopP99Ms: 1 })).toBe("missed");
  });
  it("marks a miss generator-bound when the generator's own loop was slow, but never turns a pass into anything else", () => {
    expect(verdict(150, t, { generatorLoopP99Ms: 10.1 })).toBe("generator-bound");
    expect(verdict(150, t, { generatorLoopP99Ms: 10 })).toBe("missed");
    expect(verdict(50, t, { generatorLoopP99Ms: 50 })).toBe("met");
  });
  it("is not measured for a missing or non-finite value", () => {
    expect(verdict(undefined, t, { generatorLoopP99Ms: 1 })).toBe("not measured");
    expect(verdict(Number.NaN, t, { generatorLoopP99Ms: 1 })).toBe("not measured");
  });
  it("ignores the generator when it is not a latency measure", () => {
    expect(verdict(60, { limit: 50, unit: "MB" }, { generatorLoopP99Ms: 500 })).toBe("missed");
  });
});

describe("poissonGaps", () => {
  const rng = (seed: number) => {
    let s = seed;
    return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  };
  it("has a mean gap of 1000/rate ms", () => {
    const gaps = poissonGaps(5, 20_000, rng(1));
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    expect(mean).toBeGreaterThan(190);
    expect(mean).toBeLessThan(210);
  });
  it("is deterministic for a seed, positive, and finite even when the generator returns 0", () => {
    expect(poissonGaps(2, 50, rng(7))).toEqual(poissonGaps(2, 50, rng(7)));
    for (const g of poissonGaps(100, 500, () => 0)) {
      expect(Number.isFinite(g)).toBe(true);
      expect(g).toBeGreaterThan(0);
    }
  });
  it("refuses a rate that is not positive", () => {
    expect(() => poissonGaps(0, 5, Math.random)).toThrow(/rate/);
    expect(() => poissonGaps(-1, 5, Math.random)).toThrow(/rate/);
  });
});
