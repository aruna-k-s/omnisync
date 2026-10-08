/**
 * Telemetry is an observer: nothing it does may change what the caller does. Every call into an instrument or a
 * tracer goes through here, so a broken exporter, a throwing instrument or a bad value costs one swallowed error.
 */
export function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // Deliberately silent: reporting a telemetry failure through telemetry (or the request log) is a loop and a flood.
  }
}

/**
 * A label value from a closed set. Anything else, including every value a client could choose, becomes "other",
 * so a hostile peer cannot create series.
 */
export function pick<T extends string>(allowed: readonly T[], value: unknown): T | "other" {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : "other";
}

/** Histogram buckets, in seconds, shared by every timing so dashboards and alerts agree. */
export const SECONDS_BUCKETS: number[] = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** A duration worth recording: finite and not negative. */
export function validSeconds(s: number): boolean {
  return typeof s === "number" && Number.isFinite(s) && s >= 0;
}
