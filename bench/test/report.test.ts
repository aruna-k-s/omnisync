import { describe, expect, it } from "vitest";
import { parseLoadConfig } from "../src/load/config.js";
import { TARGETS, rows, table, type LoadResults } from "../src/load/report.js";
import { gatewayLatencies, histogramQuantile, parseScrape, sampleValue } from "../src/load/scrape.js";
import { memoryGrowth, type ColdLoadResult, type EditLatencyResult, type MemoryResult, type StormResult } from "../src/load/scenarios.js";
import { traceLength, typingOps } from "../src/load/trace.js";

const sum = (p99: number, max = p99) => ({ count: 10, min: 1, p50: 2, p95: 3, p99, max });
const edit = (p99: number, loop = 1): EditLatencyResult =>
  ({ config: { editors: 100, typists: 10 }, edits: 1, editsPerSecond: 50, latencyMs: sum(p99), generator: { loopP99Ms: loop, loopMaxMs: loop }, server: {} }) as EditLatencyResult;
const mem = (mb: number): MemoryResult => ({ config: { ops: 100000 }, rssGrowthMb: mb, heapGrowthMb: 1, rssBeforeMb: 100, rssAfterMb: 100 + mb, snapshotsWritten: 3 }) as MemoryResult;
const cold = (p95: number, syncs = true): ColdLoadResult => ({ clientMs: { ...sum(p95), p95 }, snapshotBytes: 10 * 1024 * 1024, firstAfterProcessStartMs: undefined, stockClient: { syncs, detail: syncs ? "synced" : "closed before sync" } }) as ColdLoadResult;
const storm = (o: Partial<StormResult> = {}): StormResult =>
  ({
    config: { clients: 200, partitionMs: 10_000, offlineEdits: 5, seedKb: 0 },
    allBackMs: 20_000,
    backMs: sum(15_000, 20_000),
    neverReturned: 0,
    converged: true,
    live: { baseline: sum(5), partition: sum(5), storm: sum(50, 300), after: sum(5) },
    liveEdits: 100,
    server: { busyRejections: 0, rateLimited: 0, connections: 202 },
    proxy: { accepted: 1, refused: 1 },
    generator: { loopP99Ms: 1, loopMaxMs: 2 },
    ...o,
  }) as StormResult;

const verdicts = (r: LoadResults) => Object.fromEntries(rows(r).map((x) => [x.scenario, x.verdict]));
const STORM = "reconnect storm, small document";

describe("report verdicts against the targets of benchmarks.md", () => {
  it("states the targets as the spec does", () => {
    expect(TARGETS).toEqual({ editP99Ms: 100, memoryMb: 50, coldLoadP95Ms: 500, stormAllBackMs: 60_000, stormLiveMaxMs: 1000 });
  });
  it("edit latency: met up to and including 100 ms, missed above, generator-bound only when the generator lagged", () => {
    expect(verdicts({ editTypical: edit(100), editWorst: edit(100.01) })).toMatchObject({ "edit latency, typical": "met", "edit latency, worst case": "missed" });
    expect(verdicts({ editTypical: edit(300, 25) })["edit latency, typical"]).toBe("generator-bound");
  });
  it("memory: 50 MB is met, more is missed, and the generator is irrelevant", () => {
    expect(verdicts({ memory: mem(50) }).memory).toBe("met");
    expect(verdicts({ memory: mem(50.01) }).memory).toBe("missed");
  });
  it("cold load: p95 of 500 ms is met, over is missed", () => {
    expect(verdicts({ coldLoad: cold(500) })["cold load"]).toBe("met");
    expect(verdicts({ coldLoad: cold(500.1) })["cold load"]).toBe("missed");
  });
  it("cold load: a fast gateway does not meet the target if the stock client cannot open the document, and the note says why", () => {
    const rs = rows({ coldLoad: cold(50, false) });
    const row = rs.find((r) => r.scenario === "cold load")!;
    expect(row.verdict).toBe("missed");
    expect(row.note).toContain("CANNOT");
    expect(row.note).toContain("closed before sync");
    expect(rows({ coldLoad: cold(50, true) }).find((r) => r.scenario === "cold load")?.note).toContain("the stock client loads it");
  });
  it("storm: met when all back within 60 s, converged, and no live edit over a second", () => {
    expect(verdicts({ storm: storm() })[STORM]).toBe("met");
    expect(verdicts({ storm: storm({ allBackMs: 60_000 }) })[STORM]).toBe("met");
    expect(verdicts({ storm: storm({ allBackMs: 60_001 }) })[STORM]).toBe("missed");
    expect(verdicts({ storm: storm({ neverReturned: 1, allBackMs: undefined }) })[STORM]).toBe("missed");
    expect(verdicts({ storm: storm({ converged: false }) })[STORM]).toBe("missed");
    expect(verdicts({ storm: storm({ live: { baseline: sum(5), partition: sum(5), storm: sum(50, 1000), after: sum(5) } }) })[STORM]).toBe("met");
    expect(verdicts({ storm: storm({ live: { baseline: sum(5), partition: sum(5), storm: sum(50, 1001), after: sum(5) } }) })[STORM]).toBe("missed");
  });
  it("storm: a live stall with a slow generator is generator-bound, but a lost client never is", () => {
    const stall = { baseline: sum(5), partition: sum(5), storm: sum(50, 2000), after: sum(5) };
    expect(verdicts({ storm: storm({ live: stall, generator: { loopP99Ms: 30, loopMaxMs: 40 } }) })[STORM]).toBe("generator-bound");
    expect(verdicts({ storm: storm({ live: stall, neverReturned: 2, allBackMs: undefined, generator: { loopP99Ms: 30, loopMaxMs: 40 } }) })[STORM]).toBe("missed");
  });
  it("the large-document storm is judged the same way, in its own row", () => {
    const rs = rows({ storm: storm(), stormLarge: storm({ allBackMs: 61_000 }) });
    expect(rs.find((r) => r.scenario === "reconnect storm, small document")?.verdict).toBe("met");
    const large = rs.find((r) => r.scenario === "reconnect storm, large document")!;
    expect(large.verdict).toBe("missed");
    expect(large.note).toContain("last client back after 61000 ms");
  });
  it("a scenario that was not run or failed is not measured, with the reason", () => {
    const rs = rows({ memory: { error: "boom" } });
    expect(rs.map((r) => r.verdict)).toEqual(Array(6).fill("not measured"));
    expect(rs.find((r) => r.scenario === "memory")?.note).toBe("boom");
    expect(rs.find((r) => r.scenario === "cold load")?.note).toBe("not run");
  });
  it("prints a markdown table with one row per scenario", () => {
    const t = table(rows({ editTypical: edit(50), memory: mem(10) }));
    expect(t.split("\n")).toHaveLength(8);
    expect(t).toContain("| --- | --- | --- | --- | --- |");
    expect(t).toContain("met");
  });
});

describe("config", () => {
  it("has the spec's defaults", () => {
    const c = parseLoadConfig({});
    expect(c).toMatchObject({ editors: 100, seconds: 60, ops: 100_000, snapshotMb: 10, rounds: 20, stormClients: 200, partitionS: 10, offlineEdits: 5, engine: "yjs", only: [] });
  });
  it("reads settings and the database url", () => {
    const c = parseLoadConfig({ LOAD_EDITORS: "50", LOAD_ONLY: "memory, cold-load", BENCH_DATABASE_URL: "postgres://a", OMNISYNC_TEST_DATABASE_URL: "postgres://b" });
    expect(c.editors).toBe(50);
    expect(c.only).toEqual(["memory", "cold-load"]);
    expect(c.databaseUrl).toBe("postgres://a");
    expect(parseLoadConfig({ OMNISYNC_TEST_DATABASE_URL: "postgres://b" }).databaseUrl).toBe("postgres://b");
  });
  it("refuses anything unclear, naming the variable", () => {
    for (const env of [{ LOAD_EDITORS: "abc" }, { LOAD_EDITORS: "-5" }, { LOAD_EDITORS: "1" }, { LOAD_SECONDS: "0" }, { LOAD_ROUNDS: "1.5" }, { LOAD_ONLY: "nope" }, { LOAD_ENGINE: "x" }]) {
      expect(() => parseLoadConfig(env), JSON.stringify(env)).toThrow(/LOAD_/);
    }
  });
});

describe("scrape parsing", () => {
  const text = [
    "# TYPE h histogram",
    'h_bucket{outcome="ok",le="0.01"} 50',
    'h_bucket{outcome="ok",le="0.1"} 98',
    'h_bucket{outcome="ok",le="+Inf"} 100',
    'h_bucket{outcome="rejected",le="0.01"} 0',
    'h_bucket{outcome="rejected",le="0.1"} 0',
    'h_bucket{outcome="rejected",le="+Inf"} 10',
    'c_total{reason="a b"} 3',
    "g 7",
  ].join("\n");
  it("reads samples and exact-label lookups", () => {
    expect(parseScrape(text)).toHaveLength(8);
    expect(sampleValue(text, "g")).toBe(7);
    expect(sampleValue(text, "c_total", { reason: "a b" })).toBe(3);
    expect(sampleValue(text, "c_total", {})).toBeUndefined();
    expect(sampleValue(text, "missing")).toBeUndefined();
  });
  it("estimates a quantile as the first bucket bound reaching it, per label filter, Infinity in overflow", () => {
    expect(histogramQuantile(text, "h", 0.5, { outcome: "ok" })).toBe(0.01);
    expect(histogramQuantile(text, "h", 0.51, { outcome: "ok" })).toBe(0.1);
    expect(histogramQuantile(text, "h", 0.99, { outcome: "ok" })).toBe(Number.POSITIVE_INFINITY);
    expect(histogramQuantile(text, "h", 0.5)).toBe(0.1); // both outcomes summed: 50 of 110 under 0.01
    expect(histogramQuantile(text, "nope", 0.5)).toBeUndefined();
  });
});

describe("typing trace", () => {
  it("is deterministic and leaves the length it says", () => {
    const a = [...typingOps(5000, 42)];
    expect(a).toEqual([...typingOps(5000, 42)]);
    expect(a).not.toEqual([...typingOps(5000, 43)]);
    expect(traceLength(5000, 42)).toBe(a.reduce((n, o) => n + (o.kind === "insert" ? 1 : -1), 0));
    const deletes = a.filter((o) => o.kind === "delete").length;
    expect(deletes / a.length).toBeGreaterThan(0.05);
    expect(deletes / a.length).toBeLessThan(0.15);
  });
  it("never deletes from an empty text or indexes past the end, for many seeds", () => {
    for (let seed = 1; seed <= 200; seed++) {
      let len = 0;
      for (const o of typingOps(300, seed)) {
        if (o.kind === "delete") {
          expect(len, `seed ${seed}`).toBeGreaterThan(0);
          expect(o.index).toBeGreaterThanOrEqual(0);
          expect(o.index).toBeLessThan(len);
          len--;
        } else {
          expect(o.index).toBeLessThanOrEqual(len);
          len++;
        }
      }
    }
  });
});

describe("gatewayLatencies", () => {
  const hist = (name: string, labels: string, under001: number, under01: number, total: number) =>
    [`${name}_bucket{${labels}le="0.001"} ${under001}`, `${name}_bucket{${labels}le="0.01"} ${under01}`, `${name}_bucket{${labels}le="+Inf"} ${total}`].join("\n");
  const text = [
    hist("omnisync_update_apply_seconds", 'outcome="ok",', 50, 99, 100),
    hist("omnisync_ledger_append_seconds", 'outcome="ok",', 60, 100, 100),
    hist("omnisync_fanout_seconds", "", 100, 100, 100),
    'omnisync_updates_total{outcome="persisted"} 42',
    'omnisync_updates_total{outcome="duplicate"} 5',
  ].join("\n");
  it("reads the p99 of each stage and the persisted count, each from its own series", () => {
    expect(gatewayLatencies(text)).toEqual({ applyP99S: 0.01, ledgerAppendP99S: 0.01, fanoutP99S: 0.001, persisted: 42 });
  });
  it("is p99, not the median", () => {
    const g = gatewayLatencies(text);
    expect(g.applyP99S).toBe(0.01); // the median of the same buckets is 0.001
    expect(histogramQuantile(text, "omnisync_update_apply_seconds", 0.5, { outcome: "ok" })).toBe(0.001);
  });
  it("reports missing series as undefined, never zero", () => {
    expect(gatewayLatencies("")).toEqual({ applyP99S: undefined, ledgerAppendP99S: undefined, fanoutP99S: undefined, persisted: undefined });
  });
});

describe("memoryGrowth", () => {
  const MB = 1024 * 1024;
  it("is after minus before, in megabytes, and heap includes external buffers", () => {
    const g = memoryGrowth({ rss: 100 * MB, heapUsed: 20 * MB, external: 5 * MB, arrayBuffers: 0 }, { rss: 150 * MB, heapUsed: 24 * MB, external: 8 * MB, arrayBuffers: 0 });
    expect(g).toEqual({ rssGrowthMb: 50, heapGrowthMb: 7 });
  });
  it("can be negative (memory released): it is not clamped", () => {
    expect(memoryGrowth({ rss: 100 * MB, heapUsed: 0, external: 0, arrayBuffers: 0 }, { rss: 90 * MB, heapUsed: 0, external: 0, arrayBuffers: 0 }).rssGrowthMb).toBe(-10);
  });
});
