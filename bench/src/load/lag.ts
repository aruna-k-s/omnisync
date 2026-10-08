import { performance } from "node:perf_hooks";
import { percentile } from "./stats.js";

/** Event-loop lag of the load generator itself: how late a 10 ms timer fires. Recorded so a slow generator cannot pass for a slow gateway. */
export class LoopLag {
  readonly #lags: number[] = [];
  #timer: NodeJS.Timeout | undefined;
  readonly #every: number;

  constructor(everyMs = 10) {
    this.#every = everyMs;
  }

  start(): void {
    let expected = performance.now() + this.#every;
    const tick = (): void => {
      const now = performance.now();
      this.#lags.push(Math.max(0, now - expected));
      expected = now + this.#every;
      this.#timer = setTimeout(tick, this.#every);
    };
    this.#timer = setTimeout(tick, this.#every);
  }

  stop(): { p99Ms: number; maxMs: number; samples: number } {
    clearTimeout(this.#timer);
    if (this.#lags.length === 0) return { p99Ms: 0, maxMs: 0, samples: 0 };
    return { p99Ms: Math.round(percentile(this.#lags, 99) * 100) / 100, maxMs: Math.round(Math.max(...this.#lags) * 100) / 100, samples: this.#lags.length };
  }
}
