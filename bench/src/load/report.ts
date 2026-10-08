import type { ColdLoadResult, EditLatencyResult, MemoryResult, StormResult } from "./scenarios.js";
import { verdict, type Verdict } from "./stats.js";

/** Targets of docs/specs/benchmarks.md, as the harness judges them. Not edited to fit a result (load.md, rule 1). */
export const TARGETS = {
  editP99Ms: 100,
  memoryMb: 50,
  coldLoadP95Ms: 500,
  stormAllBackMs: 60_000,
  /** The spec's "no live-edit stall", made measurable: no live edit takes longer than this to reach another client during the storm. */
  stormLiveMaxMs: 1000,
} as const;

export type Failed = { error: string };
export interface LoadResults {
  editTypical?: EditLatencyResult | Failed;
  editWorst?: EditLatencyResult | Failed;
  memory?: MemoryResult | Failed;
  coldLoad?: ColdLoadResult | Failed;
  storm?: StormResult | Failed;
  stormLarge?: StormResult | Failed;
}

export interface Row {
  scenario: string;
  target: string;
  measured: string;
  verdict: Verdict;
  note: string;
}

const failed = (r: unknown): r is Failed => typeof r === "object" && r !== null && "error" in r;
const notMeasured = (scenario: string, target: string, why: string): Row => ({ scenario, target, measured: "-", verdict: "not measured", note: why });

function editRow(name: string, r: EditLatencyResult | Failed | undefined): Row {
  const target = `p99 < ${TARGETS.editP99Ms} ms`;
  if (r === undefined) return notMeasured(name, target, "not run");
  if (failed(r)) return notMeasured(name, target, r.error);
  const v = verdict(r.latencyMs.p99, { limit: TARGETS.editP99Ms, unit: "ms" }, { generatorLoopP99Ms: r.generator.loopP99Ms });
  return {
    scenario: name,
    target,
    measured: `p99 ${r.latencyMs.p99} ms (p50 ${r.latencyMs.p50}, p95 ${r.latencyMs.p95}, max ${r.latencyMs.max}) at ${r.editsPerSecond} edits/s`,
    verdict: v,
    note: `${r.config.editors} editors, ${r.config.typists} typing; generator loop p99 ${r.generator.loopP99Ms} ms${v === "generator-bound" ? " (the generator was the bottleneck: an upper bound)" : ""}`,
  };
}

function stormRow(name: string, s: StormResult | Failed | undefined): Row {
  const st = `all back < ${TARGETS.stormAllBackMs / 1000} s, no live edit over ${TARGETS.stormLiveMaxMs} ms`;
  if (s === undefined) return notMeasured(name, st, "not run");
  if (failed(s)) return notMeasured(name, st, s.error);
  const liveMax = s.live.storm?.max;
  const problems: string[] = [];
  if (s.neverReturned > 0) problems.push(`${s.neverReturned} clients never returned`);
  if (!s.converged) problems.push("did not converge");
  if (s.allBackMs !== undefined && s.allBackMs > TARGETS.stormAllBackMs) problems.push(`last client back after ${s.allBackMs} ms`);
  if (liveMax !== undefined && liveMax > TARGETS.stormLiveMaxMs) problems.push(`a live edit took ${liveMax} ms during the storm`);
  const onlyLive = problems.length === 1 && liveMax !== undefined && liveMax > TARGETS.stormLiveMaxMs;
  const v: Verdict = problems.length === 0 ? "met" : onlyLive && s.generator.loopP99Ms > 10 ? "generator-bound" : "missed";
  return {
    scenario: name,
    target: st,
    measured: `${s.allBackMs === undefined ? "not all back" : `all back in ${s.allBackMs} ms`} (clients p50 ${s.backMs?.p50 ?? "-"}, p95 ${s.backMs?.p95 ?? "-"} ms); live edits p99 ${s.live.baseline?.p99 ?? "-"} ms before, ${s.live.storm?.p99 ?? "-"} ms during (max ${liveMax ?? "-"})`,
    verdict: v,
    note: `${s.config.clients} clients, ${s.config.seedKb} KiB document, ${s.config.partitionMs / 1000} s partition, ${s.config.offlineEdits} offline edits each; busy ${s.server.busyRejections ?? 0}, rate-limited ${s.server.rateLimited ?? 0}; generator loop p99 ${s.generator.loopP99Ms} ms${problems.length ? `; ${problems.join("; ")}` : ""}`,
  };
}

export function rows(res: LoadResults): Row[] {
  const out: Row[] = [editRow("edit latency, typical", res.editTypical), editRow("edit latency, worst case", res.editWorst)];

  const m = res.memory;
  const mt = `< ${TARGETS.memoryMb} MB per document`;
  if (m === undefined) out.push(notMeasured("memory", mt, "not run"));
  else if (failed(m)) out.push(notMeasured("memory", mt, m.error));
  else out.push({ scenario: "memory", target: mt, measured: `${m.rssGrowthMb} MB resident growth (heap ${m.heapGrowthMb} MB) at ${m.config.ops} operations`, verdict: verdict(m.rssGrowthMb, { limit: TARGETS.memoryMb, unit: "MB" }, { generatorLoopP99Ms: 0 }), note: `resident ${m.rssBeforeMb} -> ${m.rssAfterMb} MB; ${m.snapshotsWritten} snapshots written` });

  const c = res.coldLoad;
  const ct = `p95 < ${TARGETS.coldLoadP95Ms} ms`;
  if (c === undefined) out.push(notMeasured("cold load", ct, "not run"));
  else if (failed(c)) out.push(notMeasured("cold load", ct, c.error));
  else {
    const timed = verdict(c.clientMs.p95, { limit: TARGETS.coldLoadP95Ms, unit: "ms" }, { generatorLoopP99Ms: 0 });
    // The target is a user-visible load: a document the stock client cannot open at all does not meet it, however fast the gateway answers.
    const v: Verdict = c.stockClient.syncs ? timed : "missed";
    out.push({
      scenario: "cold load",
      target: ct,
      measured: `p95 ${c.clientMs.p95} ms (p50 ${c.clientMs.p50}, max ${c.clientMs.max}) over ${c.clientMs.count} rounds, snapshot ${(c.snapshotBytes / 1024 / 1024).toFixed(1)} MB`,
      verdict: v,
      note: `socket open to state applied${c.firstAfterProcessStartMs === undefined ? "" : `; fresh gateway process: ${c.firstAfterProcessStartMs} ms`}; ${c.stockClient.syncs ? "the stock client loads it" : `the stock client CANNOT load it (${c.stockClient.detail})`}`,
    });
  }

  out.push(stormRow("reconnect storm, small document", res.storm), stormRow("reconnect storm, large document", res.stormLarge));
  return out;
}

/** A plain-text table for the terminal and for pasting into the spec. */
export function table(rs: readonly Row[]): string {
  const head = ["Scenario", "Target", "Measured", "Verdict", "Note"];
  const lines = [head, ...rs.map((r) => [r.scenario, r.target, r.measured, r.verdict, r.note])];
  return lines.map((l) => `| ${l.join(" | ")} |`).join("\n").replace(/^(.*)\n/, `$1\n| ${head.map(() => "---").join(" | ")} |\n`);
}
