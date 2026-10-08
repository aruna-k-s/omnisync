import type { EngineName } from "@omnisync/engine";

export const SCENARIOS = ["edit-latency", "memory", "cold-load", "reconnect-storm"] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

export interface LoadConfig {
  editors: number;
  seconds: number;
  ops: number;
  snapshotMb: number;
  rounds: number;
  stormClients: number;
  partitionS: number;
  offlineEdits: number;
  stormDocKb: number;
  engine: EngineName;
  only: ScenarioName[];
  databaseUrl: string | undefined;
}

function whole(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number, min = 1, max = 1_000_000): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]{1,9}$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new Error(`${name} must be a whole number between ${min} and ${max}`);
  return Number(raw);
}

/** Reads the LOAD_* settings of docs/specs/load.md. Refuses anything unclear rather than running a different load than asked for. */
export function parseLoadConfig(env: Readonly<Record<string, string | undefined>>): LoadConfig {
  const only = (env["LOAD_ONLY"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const o of only) if (!(SCENARIOS as readonly string[]).includes(o)) throw new Error(`LOAD_ONLY names an unknown scenario "${o}" (known: ${SCENARIOS.join(", ")})`);
  const engine = env["LOAD_ENGINE"] ?? "yjs";
  if (!["yjs", "automerge", "loro"].includes(engine)) throw new Error('LOAD_ENGINE must be one of "yjs", "automerge", "loro"');
  return {
    editors: whole(env, "LOAD_EDITORS", 100, 6, 2000),
    seconds: whole(env, "LOAD_SECONDS", 60, 5, 3600),
    ops: whole(env, "LOAD_OPS", 100_000, 100, 10_000_000),
    snapshotMb: whole(env, "LOAD_SNAPSHOT_MB", 10, 1, 200),
    rounds: whole(env, "LOAD_ROUNDS", 20, 1, 1000),
    stormClients: whole(env, "LOAD_STORM_CLIENTS", 200, 2, 2000),
    partitionS: whole(env, "LOAD_PARTITION_S", 10, 1, 3600),
    offlineEdits: whole(env, "LOAD_OFFLINE_EDITS", 5, 1, 1000),
    stormDocKb: whole(env, "LOAD_STORM_DOC_KB", 800, 1, 1000),
    engine: engine as EngineName,
    only: only as ScenarioName[],
    databaseUrl: env["BENCH_DATABASE_URL"] || env["OMNISYNC_TEST_DATABASE_URL"] || undefined,
  };
}
