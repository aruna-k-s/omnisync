/** Token bucket per key with a hard bound on tracked keys (oldest evicted first). */
export class KeyedRateLimiter {
  readonly #buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly burst: number,
    private readonly perMinute: number,
    private readonly now: () => number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Returns 0 if allowed, else milliseconds until a token is available. */
  take(key: string): number {
    const t = this.now();
    const b = this.#buckets.get(key) ?? { tokens: this.burst, at: t };
    b.tokens = Math.min(this.burst, b.tokens + (Math.max(0, t - b.at) / 60_000) * this.perMinute);
    b.at = Math.max(b.at, t);
    this.#buckets.delete(key); // re-insert so Map order is recency
    this.#buckets.set(key, b);
    if (this.#buckets.size > this.maxKeys) this.#buckets.delete(this.#buckets.keys().next().value as string);
    if (b.tokens < 1) return Math.ceil(((1 - b.tokens) / this.perMinute) * 60_000);
    b.tokens -= 1;
    return 0;
  }

  get size(): number {
    return this.#buckets.size;
  }
}
