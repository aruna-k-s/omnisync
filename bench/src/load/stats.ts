/** Statistics for the load harness (spec: docs/specs/load.md). Small and strict: a wrong percentile here would put a wrong number in the spec. */

/** Nearest-rank percentile: the ceil(p/100 * n)th smallest sample. Does not modify its input. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) throw new Error("percentile: no samples");
  if (!(p >= 0 && p <= 100)) throw new Error(`percentile: ${p} is outside 0..100`);
  if (!samples.every(Number.isFinite)) throw new Error("percentile: samples must be finite");
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] as number;
}

export interface Summary {
  count: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function summarize(samples: readonly number[]): Summary {
  if (samples.length === 0) throw new Error("summarize: no samples");
  return {
    count: samples.length,
    min: r3(percentile(samples, 0)),
    p50: r3(percentile(samples, 50)),
    p95: r3(percentile(samples, 95)),
    p99: r3(percentile(samples, 99)),
    max: r3(percentile(samples, 100)),
  };
}

export interface Timed {
  /** Milliseconds on the generator's clock when the sample was taken. */
  at: number;
  ms: number;
}

/** Drops samples taken in the first `fraction` of the run (but at least `minMs`), measured from the first sample. */
export function dropWarmup<T extends { at: number }>(samples: readonly T[], fraction: number, minMs: number): T[] {
  if (samples.length === 0) throw new Error("dropWarmup: no samples");
  const first = Math.min(...samples.map((s) => s.at));
  const last = Math.max(...samples.map((s) => s.at));
  const cut = first + Math.max((last - first) * fraction, minMs);
  const kept = samples.filter((s) => s.at >= cut);
  if (kept.length === 0) throw new Error("dropWarmup: the warm-up covers the whole run");
  return kept;
}

export type Verdict = "met" | "missed" | "generator-bound" | "not measured";

/** Latency at or under the limit is met. Over it is missed, unless the generator's own event loop was slow, in which case the number says more about the generator. */
export function verdict(value: number | undefined, target: { limit: number; unit: "ms" | "MB" }, ctx: { generatorLoopP99Ms: number }): Verdict {
  if (value === undefined || !Number.isFinite(value)) return "not measured";
  if (value <= target.limit) return "met";
  if (target.unit === "ms" && ctx.generatorLoopP99Ms > 10) return "generator-bound";
  return "missed";
}

/** Gaps (ms) between the events of a Poisson process with `ratePerSecond`, from a uniform generator. */
export function poissonGaps(ratePerSecond: number, n: number, rand: () => number): number[] {
  if (!(ratePerSecond > 0)) throw new Error("poissonGaps: rate must be positive");
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = Math.min(Math.max(rand(), Number.EPSILON), 1 - Number.EPSILON);
    out.push((-Math.log(1 - u) / ratePerSecond) * 1000);
  }
  return out;
}
