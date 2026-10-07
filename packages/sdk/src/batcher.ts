export interface BatcherOptions<T> {
  /** A burst of edits within this window shares one flush (default 50 ms). */
  minMs?: number;
  /** A flush never waits longer than this after the first unflushed edit (default 250 ms). */
  maxMs?: number;
  /** Receives every edit made since the last flush, in order. Flushes never overlap. */
  flush(items: T[]): Promise<void>;
  /** Called when a flush fails. The items stay out of the batcher: the caller decides what that means. */
  onError?(error: Error, items: T[]): void;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

/**
 * Collects edits and hands them over in bursts: the first edit starts a `minMs` timer, each further edit
 * restarts it, and the wait is capped at `maxMs` from the first unflushed edit.
 */
export class Batcher<T> {
  readonly #minMs: number;
  readonly #maxMs: number;
  readonly #flush: (items: T[]) => Promise<void>;
  readonly #onError: ((e: Error, items: T[]) => void) | undefined;
  readonly #now: () => number;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (h: unknown) => void;
  #items: T[] = [];
  #firstAt = 0;
  #timer: unknown;
  #running: Promise<void> = Promise.resolve();

  constructor(opts: BatcherOptions<T>) {
    this.#minMs = opts.minMs ?? 50;
    this.#maxMs = opts.maxMs ?? 250;
    if (!(this.#minMs >= 0) || !(this.#maxMs >= this.#minMs)) throw new RangeError("need 0 <= minMs <= maxMs");
    this.#flush = opts.flush;
    this.#onError = opts.onError;
    this.#now = opts.now ?? Date.now;
    this.#setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get size(): number {
    return this.#items.length;
  }

  add(item: T): void {
    const now = this.#now();
    if (this.#items.length === 0) this.#firstAt = now;
    this.#items.push(item);
    if (this.#timer !== undefined) this.#clearTimer(this.#timer);
    const wait = Math.max(0, Math.min(this.#minMs, this.#firstAt + this.#maxMs - now));
    this.#timer = this.#setTimer(() => void this.flush(), wait);
  }

  /** Flushes now and resolves when everything made so far has been handed over. */
  flush(): Promise<void> {
    if (this.#timer !== undefined) this.#clearTimer(this.#timer);
    this.#timer = undefined;
    const items = this.#items;
    this.#items = [];
    this.#running = this.#running.then(async () => {
      if (items.length === 0) return;
      try {
        await this.#flush(items);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (this.#onError) this.#onError(err, items);
        else throw err;
      }
    });
    return this.#running;
  }

  /** Stops the timer without flushing. */
  dispose(): void {
    if (this.#timer !== undefined) this.#clearTimer(this.#timer);
    this.#timer = undefined;
    this.#items = [];
  }
}
