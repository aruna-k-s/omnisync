export interface BackoffOptions {
  attempt: number;
  baseMs: number;
  maxMs: number;
  /** A server hint (`busy;retry_after_ms=N`): the wait is never shorter than this. */
  floorMs?: number;
  random: () => number;
}

/** Full jitter: uniform in [0, min(maxMs, baseMs * 2^attempt)], raised to the server's floor. */
export function backoffDelay(o: BackoffOptions): number {
  const ceiling = Math.min(o.maxMs, o.baseMs * 2 ** Math.min(Math.max(0, o.attempt), 20));
  const jittered = Math.floor(Math.min(Math.max(o.random(), 0), 0.999_999_999) * (ceiling + 1));
  return Math.max(jittered, o.floorMs ?? 0);
}
