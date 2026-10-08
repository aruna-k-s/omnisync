import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneMetrics } from "../src/control-plane-metrics.js";
import { GatewayMetrics } from "../src/gateway-metrics.js";
import { testMeter } from "../src/testing.js";

/**
 * The metric tables in docs/specs/observability.md are the catalogue that the dashboard, the alert rules and the
 * operator guide are checked against (deploy/tests/promql_util.py parses the same tables). This test holds the other
 * side: what a real scrape exposes is exactly what the tables promise, in both directions.
 */

interface Row {
  name: string;
  type: string;
  labels: string[];
  /** Label values the spec lists after `=`, where it lists any. */
  values: Record<string, string[]>;
}

const SPEC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "specs", "observability.md");

function parseCatalogue(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    const m = /^\| `(omnisync_[a-z_]+)` \| (gauge|counter|histogram) \| (.*?) \| .* \|$/.exec(line);
    if (!m) continue;
    const cell = m[3] as string;
    const labels: string[] = [];
    const values: Record<string, string[]> = {};
    if (cell.trim() !== "none") {
      for (const part of cell.split(/,\s*(?=`)/)) {
        const name = /^`([a-z_]+)`/.exec(part.trim())?.[1];
        if (name === undefined) continue;
        labels.push(name);
        const eq = /=\s*(.+)$/.exec(part);
        if (eq) values[name] = (eq[1] as string).split(",").map((v) => v.trim());
      }
    }
    rows.push({ name: m[1] as string, type: m[2] as string, labels, values });
  }
  return rows;
}

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.map((f) => f()));
  cleanup = [];
});

/** Every instrument exercised once with every closed-set label value, then scraped as text. */
async function fullScrape(): Promise<string> {
  const t = testMeter();
  cleanup.push(t.shutdown);
  const g = new GatewayMetrics(t.meter);
  g.observe({
    connections: () => 3,
    documents: () => 2,
    appendQueueDepth: () => 1,
    degraded: () => false,
    stats: () => ({
      persisted: 5,
      duplicates: 1,
      snapshotFailures: 1,
      authenticated: 4,
      busyRejections: 1,
      authFailures: { bad_token: 1 },
      rejected: { unknown_key: 1, bad_signature: 1, not_update: 1, rate_limited: 1, forbidden: 1, upload_only: 1, malformed: 1, claimed_time: 1, unavailable: 1 },
    }),
  });
  g.observeCheckpoints({ stats: () => ({ uploaded: 2, signFailures: 1, storeFailures: 1, uploadFailures: 1, uploadConflicts: 1 }), behindSeconds: () => 12 });
  for (const outcome of ["ok", "rejected"] as const) g.updateFinished(0.01, outcome);
  for (const outcome of ["ok", "error"] as const) g.ledgerAppend(0.01, outcome);
  g.fanout(0.002);

  const c = new ControlPlaneMetrics(t.meter);
  c.request({ route: "/v1/auth/callback", method: "GET", status: 302, seconds: 0.01 });
  c.request({ route: "/v1/auth/callback", method: "GET", status: 401, seconds: 0.01 });
  c.request({ route: "/v1/certificates", method: "POST", status: 201, seconds: 0.01 });
  c.request({ route: "/v1/certificates", method: "POST", status: 429, seconds: 0.01 });
  return t.scrape();
}

function parseScrape(text: string): { types: Map<string, string>; labels: Map<string, Map<string, Set<string>>> } {
  const types = new Map<string, string>();
  const labels = new Map<string, Map<string, Set<string>>>();
  for (const line of text.split("\n")) {
    const t = /^# TYPE (\S+) (\S+)$/.exec(line);
    if (t) {
      types.set(t[1] as string, t[2] as string);
      continue;
    }
    const s = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+\S+/.exec(line);
    if (line.startsWith("#") || !s) continue;
    const family = (s[1] as string).replace(/_(bucket|count|sum)$/, "");
    const byLabel = labels.get(family) ?? new Map<string, Set<string>>();
    labels.set(family, byLabel);
    for (const part of (s[2] ?? "").matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
      const k = part[1] as string;
      if (k === "le") continue;
      (byLabel.get(k) ?? byLabel.set(k, new Set()).get(k))?.add(part[2] as string);
    }
  }
  return { types, labels };
}

describe("the metric catalogue in the spec", () => {
  const spec = readFileSync(SPEC, "utf8");
  const catalogue = parseCatalogue(spec);

  it("is parsed from the spec tables (nineteen families, each once)", () => {
    expect(catalogue).toHaveLength(19);
    expect(new Set(catalogue.map((r) => r.name)).size).toBe(19);
    expect(catalogue.map((r) => r.type).filter((t) => t === "histogram")).toHaveLength(4);
    expect(catalogue.find((r) => r.name === "omnisync_http_request_seconds")?.labels).toEqual(["route", "method", "status_class"]);
    expect(catalogue.find((r) => r.name === "omnisync_signature_failures_total")?.values).toEqual({ reason: ["unknown_key", "bad_signature", "not_update"] });
    expect(catalogue.find((r) => r.name === "omnisync_fanout_seconds")?.labels).toEqual([]);
  });

  it("matches a real scrape: same names, same types", async () => {
    const { types } = parseScrape(await fullScrape());
    const exposed = [...types.keys()].filter((n) => n.startsWith("omnisync_")).sort();
    expect(exposed).toEqual(catalogue.map((r) => r.name).sort());
    for (const row of catalogue) expect(types.get(row.name), row.name).toBe(row.type);
  });

  it("matches a real scrape: same label names for every metric", async () => {
    const { labels } = parseScrape(await fullScrape());
    for (const row of catalogue) {
      const got = [...(labels.get(row.name)?.keys() ?? [])].sort();
      expect(got, row.name).toEqual([...row.labels].sort());
    }
  });

  it("matches a real scrape: the label values the spec lists are exactly those exposed", async () => {
    const { labels } = parseScrape(await fullScrape());
    for (const row of catalogue) {
      for (const [label, listed] of Object.entries(row.values)) {
        expect([...(labels.get(row.name)?.get(label) ?? [])].sort(), `${row.name}{${label}}`).toEqual([...listed].sort());
      }
    }
  });

  it("every histogram exposes the boundaries the spec states", async () => {
    const text = await fullScrape();
    const stated = /Histogram buckets \(seconds\): ([0-9., ]+)\./.exec(spec)?.[1]?.split(",").map((v) => Number(v.trim()));
    expect(stated).toHaveLength(13);
    for (const row of catalogue.filter((r) => r.type === "histogram")) {
      const les = [...text.matchAll(new RegExp(`^${row.name}_bucket\\{[^}]*le="([^"]+)"`, "gm"))].map((m) => m[1] as string);
      const finite = [...new Set(les.filter((v) => v !== "+Inf").map(Number))].sort((a, b) => a - b);
      expect(finite, row.name).toEqual(stated);
      expect(les).toContain("+Inf");
    }
  });
});
