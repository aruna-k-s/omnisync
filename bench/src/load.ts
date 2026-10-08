/**
 * Load harness (spec: docs/specs/load.md).
 *
 *   OMNISYNC_TEST_DATABASE_URL=postgres://... pnpm load            # all four scenarios at the spec's sizes
 *   LOAD_ONLY=cold-load LOAD_ROUNDS=5 pnpm load                    # one scenario, smaller
 *
 * Writes bench/results/load-<timestamp>.json and prints the table with a verdict against each target.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { percentile } from "./load/stats.js";
import { parseLoadConfig, type ScenarioName } from "./load/config.js";
import { rows, table, type Failed, type LoadResults } from "./load/report.js";
import { coldLoad, editLatency, memory, reconnectStorm } from "./load/scenarios.js";
import { makeWorld } from "./load/world.js";

const cfg = parseLoadConfig(process.env);
if (!cfg.databaseUrl) throw new Error("set BENCH_DATABASE_URL or OMNISYNC_TEST_DATABASE_URL: the load numbers are for a durable store (persist-before-ACK)");
const wants = (s: ScenarioName) => cfg.only.length === 0 || cfg.only.includes(s);

async function pgFacts(): Promise<{ version: string; fsync: string; synchronousCommit: string; walSyncMethod: string }> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 1 });
  try {
    const one = async (sql: string) => String(Object.values((await pool.query(sql)).rows[0] ?? {})[0]);
    return { version: await one("select version()"), fsync: await one("show fsync"), synchronousCommit: await one("show synchronous_commit"), walSyncMethod: await one("show wal_sync_method") };
  } finally {
    await pool.end();
  }
}

/** What one durable write costs on this machine's disk (write + fsync of 8 KB in the temp directory): the floor under every persist-before-ACK number. */
function fsyncCost(): { p50Us: number; p99Us: number } {
  const path = join(os.tmpdir(), `omnisync-fsync-${process.pid}`);
  const fd = openSync(path, "w");
  const buf = Buffer.alloc(8192, 1);
  const us: number[] = [];
  try {
    for (let i = 0; i < 300; i++) {
      const t = performance.now();
      writeSync(fd, buf, 0, buf.length, 0);
      fsyncSync(fd);
      us.push((performance.now() - t) * 1000);
    }
  } finally {
    closeSync(fd);
    rmSync(path, { force: true });
  }
  return { p50Us: Math.round(percentile(us, 50)), p99Us: Math.round(percentile(us, 99)) };
}

const environment = {
  at: new Date().toISOString(),
  node: process.version,
  cpus: os.cpus().length,
  cpuModel: os.cpus()[0]?.model,
  memoryGb: Math.round(os.totalmem() / 1024 ** 3),
  kernel: os.release(),
  platform: os.platform(),
  postgres: await pgFacts(),
  fsyncOf8KbWrite: fsyncCost(),
  store: "PostgreSQL (loopback TCP), snapshots on the file system",
  network: "loopback, gateway and generator in separate processes on the same host",
  auth: "static keys (no certificate handshake)",
};

const results: LoadResults = {};
mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
const file = new URL(`../results/load-${environment.at.replace(/[:.]/g, "-")}.json`, import.meta.url);
/** Written after every scenario, so a hang or a crash later does not lose what was measured. */
const save = (): void => writeFileSync(file, JSON.stringify({ environment, config: cfg, results, verdicts: rows(results) }, null, 2));
const run = async <T>(name: string, fn: () => Promise<T>): Promise<T | Failed> => {
  console.log(`\n== ${name}`);
  const t = Date.now();
  try {
    const r = await fn();
    console.log(`   done in ${((Date.now() - t) / 1000).toFixed(1)} s`);
    return r;
  } catch (e) {
    console.log(`   FAILED: ${(e as Error).message}`);
    return { error: (e as Error).message };
  } finally {
    setImmediate(save);
  }
};

async function inWorld<T>(keys: number, fn: (w: Awaited<ReturnType<typeof makeWorld>>) => Promise<T>): Promise<T> {
  const w = await makeWorld({ databaseUrl: cfg.databaseUrl, keys, engine: cfg.engine });
  try {
    return await fn(w);
  } finally {
    await w.cleanup();
  }
}

const edit = (typists: number, rate: number) => ({ engine: cfg.engine, editors: cfg.editors, typists, ratePerTypist: rate, seconds: cfg.seconds, probes: 5, minWarmupMs: 2000, seed: 7 });

if (wants("edit-latency")) {
  results.editTypical = await run("edit latency, typical (10 typists at 5 edits/s)", () => inWorld(cfg.editors, (w) => editLatency(w, edit(Math.min(10, cfg.editors), 5))));
  results.editWorst = await run("edit latency, worst case (everyone types, 2 edits/s each)", () => inWorld(cfg.editors, (w) => editLatency(w, edit(cfg.editors, 2))));
}
if (wants("memory")) results.memory = await run(`memory at ${cfg.ops} operations`, () => inWorld(1, (w) => memory(w, { engine: cfg.engine, ops: cfg.ops, seed: 42, window: 500 })));
if (wants("cold-load")) results.coldLoad = await run(`cold load of a ${cfg.snapshotMb} MB snapshot`, () => inWorld(2, (w) => coldLoad(w, { engine: cfg.engine, snapshotBytes: cfg.snapshotMb * 1024 * 1024, chunks: 1000, rounds: cfg.rounds, seed: 3 }, (m) => console.log(`   ${m}`))));
const storm = (seedKb: number) => () =>
  inWorld(cfg.stormClients + 2, (w) => reconnectStorm(w, { engine: cfg.engine, clients: cfg.stormClients, partitionMs: cfg.partitionS * 1000, offlineEdits: cfg.offlineEdits, baselineMs: 5000, liveEditsPerSecond: 10, limitMs: 120_000, seedKb }));
if (wants("reconnect-storm")) {
  results.storm = await run(`reconnect storm, ${cfg.stormClients} clients, small document`, storm(0));
  results.stormLarge = await run(`reconnect storm, ${cfg.stormClients} clients, ${cfg.stormDocKb} KiB document`, storm(cfg.stormDocKb));
}

const verdicts = rows(results);
console.log(`\n${table(verdicts)}\n`);
save();
console.log(`raw results: ${file.pathname}`);
