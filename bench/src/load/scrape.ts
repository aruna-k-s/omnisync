/** Reading Prometheus text, for the harness. Strict: a missing series is `undefined`, never zero. */

export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export function parseScrape(text: string): Sample[] {
  const out: Sample[] = [];
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    for (const part of (m[2] ?? "").matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[part[1] as string] = part[2] as string;
    out.push({ name: m[1] as string, labels, value: Number(m[3]) });
  }
  return out;
}

/** Value of the series with exactly these labels. */
export function sampleValue(text: string, name: string, labels: Record<string, string> = {}): number | undefined {
  const keys = Object.keys(labels);
  return parseScrape(text).find((s) => s.name === name && Object.keys(s.labels).length === keys.length && keys.every((k) => s.labels[k] === labels[k]))?.value;
}

/**
 * Estimates a quantile of a Prometheus histogram family from its cumulative buckets, summed over label sets that match
 * `where`: the upper bound of the first bucket whose cumulative count reaches q * total. An upper bound, as accurate as
 * the bucket boundaries are; `Infinity` when the quantile falls in the overflow bucket.
 */
export function histogramQuantile(text: string, family: string, q: number, where: Record<string, string> = {}): number | undefined {
  const byLe = new Map<number, number>();
  for (const s of parseScrape(text)) {
    if (s.name !== `${family}_bucket`) continue;
    if (!Object.entries(where).every(([k, v]) => s.labels[k] === v)) continue;
    const le = s.labels["le"] === "+Inf" ? Number.POSITIVE_INFINITY : Number(s.labels["le"]);
    byLe.set(le, (byLe.get(le) ?? 0) + s.value);
  }
  if (byLe.size === 0) return undefined;
  const bounds = [...byLe.keys()].sort((a, b) => a - b);
  const total = byLe.get(Number.POSITIVE_INFINITY) ?? byLe.get(bounds[bounds.length - 1] as number) ?? 0;
  if (total === 0) return undefined;
  for (const b of bounds) if ((byLe.get(b) as number) >= q * total) return b;
  return Number.POSITIVE_INFINITY;
}

export interface GatewayLatencies {
  applyP99S: number | undefined;
  ledgerAppendP99S: number | undefined;
  fanoutP99S: number | undefined;
  persisted: number | undefined;
}

/** What a scrape of the gateway says about itself after a run: the p99 of the three timed stages and the updates made durable. */
export function gatewayLatencies(text: string): GatewayLatencies {
  return {
    applyP99S: histogramQuantile(text, "omnisync_update_apply_seconds", 0.99, { outcome: "ok" }),
    ledgerAppendP99S: histogramQuantile(text, "omnisync_ledger_append_seconds", 0.99, { outcome: "ok" }),
    fanoutP99S: histogramQuantile(text, "omnisync_fanout_seconds", 0.99),
    persisted: sampleValue(text, "omnisync_updates_total", { outcome: "persisted" }),
  };
}
