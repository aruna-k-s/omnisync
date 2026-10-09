import { performance } from "node:perf_hooks";
import { GatewayClient } from "@omnisync/gateway";
import type { EngineName } from "@omnisync/engine";
import type { GatewayProcess, MemoryReading } from "./gateway-process.js";
import { LoopLag } from "./lag.js";
import { PartitionProxy } from "./proxy.js";
import { RawPeer, coldSync, updateKey } from "./peers.js";
import { gatewayLatencies, sampleValue, type GatewayLatencies } from "./scrape.js";
import { dropWarmup, poissonGaps, summarize, type Summary, type Timed } from "./stats.js";
import { rng, traceLength, typingOps } from "./trace.js";
import type { World } from "./world.js";

/** The four scenarios of docs/specs/load.md. Each returns plain data and throws when an edit is lost or a client never returns. */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const now = () => performance.now();

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = now() + ms;
  while (!cond()) {
    if (now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(10);
  }
}

/** Wraps `insertText` so the time before each local edit is recorded against the update it produces. */
function stamp(client: GatewayClient, record: (update: Uint8Array, t0: number) => void): void {
  const doc = client.doc;
  const original = doc.insertText.bind(doc);
  doc.insertText = (index: number, text: string) => {
    const t0 = now();
    const update = original(index, text);
    record(update, t0);
    return update;
  };
}

const r2 = (x: number) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------------------------------------------------------------
// edit latency

export interface EditLatencyConfig {
  engine: EngineName;
  /** Connections on the one document. */
  editors: number;
  /** How many of them type. */
  typists: number;
  ratePerTypist: number;
  /** Seconds of typing (warm-up included). */
  seconds: number;
  /** Full clients that apply every update and measure. */
  probes: number;
  minWarmupMs: number;
  seed: number;
}

export interface EditLatencyResult {
  config: EditLatencyConfig;
  edits: number;
  editsPerSecond: number;
  latencyMs: Summary;
  samplesDiscarded: number;
  warmupMs: number;
  ackMs: Summary | undefined;
  generator: { loopP99Ms: number; loopMaxMs: number };
  server: GatewayLatencies;
}

/** Hooks for the harness's own tests: they let a test sabotage a run to prove the scenario notices. Never set by the CLI. */
export interface EditLatencyHooks {
  afterConnect?(ctx: { probes: GatewayClient[]; raws: RawPeer[] }): void;
  /** How long to wait for every edit to arrive before declaring one lost (default 20 s). */
  drainMs?: number;
}

export async function editLatency(world: World, cfg: EditLatencyConfig, hooks: EditLatencyHooks = {}): Promise<EditLatencyResult> {
  if (cfg.probes < 1 || cfg.probes > cfg.editors) throw new Error("probes must be between 1 and editors");
  if (cfg.typists < 1 || cfg.typists > cfg.editors) throw new Error("typists must be between 1 and editors");
  if (world.keys.length < cfg.editors) throw new Error("the world has fewer keys than editors");
  const gw = await world.start({ engine: cfg.engine });
  const docId = "load-edit";
  const probes: GatewayClient[] = [];
  const raws: RawPeer[] = [];
  try {
    for (let i = 0; i < cfg.probes; i++) probes.push(await GatewayClient.connect({ url: gw.url, docId, actor: i + 1, key: world.keys[i]!, engine: cfg.engine }));
    for (let i = cfg.probes; i < cfg.editors; i += 25) {
      const batch = [];
      for (let j = i; j < Math.min(i + 25, cfg.editors); j++) batch.push(RawPeer.connect({ url: gw.url, docId, key: world.keys[j]!, actor: j + 1, engine: cfg.engine }));
      raws.push(...(await Promise.all(batch)));
    }

    hooks.afterConnect?.({ probes, raws });
    const sent = new Map<string, { t0: number; from: number }>();
    const sentBy = new Array<number>(cfg.editors).fill(0);
    const samples: (Timed & { probe: number })[] = [];
    const got = new Array<number>(cfg.probes).fill(0);
    probes.forEach((p, pi) => {
      stamp(p, (u, t0) => void sent.set(updateKey(u), { t0, from: pi }));
      p.onRemoteUpdate((u) => {
        const e = sent.get(updateKey(u));
        if (!e) return;
        const t = now();
        got[pi]!++;
        samples.push({ at: t, ms: t - e.t0, probe: pi });
      });
    });

    // Who types: raw peers first (they are cheap), then probes.
    const order: { kind: "raw" | "probe"; index: number; global: number }[] = [
      ...raws.map((_, i) => ({ kind: "raw" as const, index: i, global: cfg.probes + i })),
      ...probes.map((_, i) => ({ kind: "probe" as const, index: i, global: i })),
    ];
    const typists = order.slice(0, cfg.typists);
    for (const t of typists) if (t.kind === "raw") raws[t.index]!.trackAcks();

    const lag = new LoopLag();
    lag.start();
    const rand = rng(cfg.seed);
    const t0 = now();
    const end = t0 + cfg.seconds * 1000;
    let stop = false;
    const loops = typists.map(async (t) => {
      const gaps = poissonGaps(cfg.ratePerTypist, Math.ceil(cfg.ratePerTypist * cfg.seconds * 1.5) + 20, rand);
      let due = t0 + rand() * (1000 / cfg.ratePerTypist); // spread the first edits
      for (const gap of gaps) {
        due += gap;
        if (due >= end || stop) break;
        const wait = due - now();
        if (wait > 0) await sleep(wait);
        if (t.kind === "raw") {
          const { update, t0: at } = raws[t.index]!.type("x");
          sent.set(updateKey(update), { t0: at, from: t.global });
        } else {
          const p = probes[t.index]!;
          void p.insert(p.doc.getText().length, "x");
        }
        sentBy[t.global]!++;
      }
    });
    await Promise.all(loops);
    stop = true;
    const total = sentBy.reduce((a, b) => a + b, 0);

    // Every edit must reach every probe, and every raw typist must have been acknowledged.
    try {
      await until(() => probes.every((_, pi) => got[pi]! >= total - sentBy[pi]!), hooks.drainMs ?? 20_000, "every probe to receive every edit");
      await until(() => raws.every((r) => r.unacked === 0), hooks.drainMs ?? 20_000, "every typist to be acknowledged");
    } catch (e) {
      const missing = probes.map((_, pi) => total - sentBy[pi]! - got[pi]!);
      throw new Error(`edits were lost: probes are missing ${JSON.stringify(missing)} of ${total} (${(e as Error).message})`, { cause: e });
    }
    const gen = lag.stop();
    const text = await gw.scrape();

    const kept = dropWarmup(samples, 0.1, cfg.minWarmupMs);
    const acks = raws.flatMap((r) => r.ackSamples);
    const keptAcks = acks.length > 0 ? dropWarmup(acks, 0.1, cfg.minWarmupMs) : [];
    const first = Math.min(...samples.map((s) => s.at));
    return {
      config: cfg,
      edits: total,
      editsPerSecond: r2(total / cfg.seconds),
      latencyMs: summarize(kept.map((s) => s.ms)),
      samplesDiscarded: samples.length - kept.length,
      warmupMs: Math.round(Math.min(...kept.map((s) => s.at)) - first),
      ackMs: keptAcks.length > 0 ? summarize(keptAcks.map((s) => s.ms)) : undefined,
      generator: { loopP99Ms: gen.p99Ms, loopMaxMs: gen.maxMs },
      server: gatewayLatencies(text),
    };
  } finally {
    await Promise.all([...probes.map((p) => p.close()), ...raws.map((r) => r.close())]);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// memory

export interface MemoryConfig {
  engine: EngineName;
  ops: number;
  seed: number;
  /** Unacknowledged edits in flight at once. */
  window: number;
}

export interface MemoryResult {
  config: MemoryConfig;
  textLength: number;
  fillSeconds: number;
  opsPerSecond: number;
  rssBeforeMb: number;
  rssAfterMb: number;
  rssGrowthMb: number;
  heapGrowthMb: number;
  snapshotsWritten: number;
  documentsResident: number;
}

const mb = (b: number) => r2(b / 1024 / 1024);

/** Resident-set growth and heap growth (heap plus external buffers) between two readings of the gateway process. */
export function memoryGrowth(before: MemoryReading, after: MemoryReading): { rssGrowthMb: number; heapGrowthMb: number } {
  return { rssGrowthMb: mb(after.rss - before.rss), heapGrowthMb: mb(after.heapUsed + after.external - (before.heapUsed + before.external)) };
}

export interface MemoryHooks {
  afterFill?(ctx: { client: GatewayClient }): Promise<void> | void;
}

export async function memory(world: World, cfg: MemoryConfig, hooks: MemoryHooks = {}): Promise<MemoryResult> {
  const gw = await world.start({ engine: cfg.engine, idleEvictMs: 3_600_000 });
  const before = await gw.memory();
  const c = await GatewayClient.connect({ url: gw.url, docId: "load-memory", actor: 1, key: world.keys[0]!, engine: cfg.engine });
  try {
    const t0 = now();
    let pending: Promise<void>[] = [];
    for (const op of typingOps(cfg.ops, cfg.seed)) {
      pending.push(op.kind === "insert" ? c.insert(op.index, op.text) : c.delete(op.index, 1));
      if (pending.length >= cfg.window) {
        await Promise.all(pending);
        pending = [];
      }
    }
    await Promise.all(pending);
    const fillMs = now() - t0;
    await hooks.afterFill?.({ client: c });
    const expected = traceLength(cfg.ops, cfg.seed);
    if (c.doc.getText().length !== expected) throw new Error("the client's document does not have the length the trace implies");
    const after = await gw.memory();
    const stats = await gw.stats();
    if (stats["persisted"] !== cfg.ops) throw new Error(`the gateway persisted ${String(stats["persisted"])} of ${cfg.ops} operations`);
    const documents = Number(stats["documents"]);
    return {
      config: cfg,
      textLength: expected,
      fillSeconds: r2(fillMs / 1000),
      opsPerSecond: Math.round(cfg.ops / (fillMs / 1000)),
      rssBeforeMb: mb(before.rss),
      rssAfterMb: mb(after.rss),
      ...memoryGrowth(before, after),
      snapshotsWritten: Number(stats["snapshots"]),
      documentsResident: documents,
    };
  } finally {
    await c.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// cold load

export interface ColdLoadConfig {
  engine: EngineName;
  snapshotBytes: number;
  /** The fill is this many updates, so a snapshot lands exactly at the end (compaction runs every 100). */
  chunks: number;
  rounds: number;
  seed: number;
}

export interface ColdLoadResult {
  config: ColdLoadConfig;
  snapshotBytes: number;
  textLength: number;
  /** Socket open to the state applied on a fresh replica, with a decoder that accepts large frames (see `coldSync`). */
  clientMs: Summary;
  /** Whether the stock client (`GatewayClient`) can load this document at all. Ticket L1: it could not above 1 MiB until the inbound cap was raised (docs/specs/large-sync.md). */
  stockClient: { syncs: boolean; detail: string };
  /** How the gateway loaded the room in the last round: from which snapshot version, replaying how many updates after it. */
  loadedFrom: { snapshotVersion: number; replayed: number } | undefined;
  /** Times the gateway loaded the room from the store in total: the fill, then one per round. */
  roomLoads: number;
  /** A fresh gateway process on the same store, nothing warm. Only with a store that outlives the process (PostgreSQL). */
  firstAfterProcessStartMs: number | undefined;
  fillSeconds: number;
}

export interface ColdLoadHooks {
  /** Called with the filling client once the snapshot exists, before it disconnects. */
  afterFill?(client: GatewayClient): Promise<void> | void;
}

export async function coldLoad(world: World, cfg: ColdLoadConfig, log: (message: string) => void = () => {}, hooks: ColdLoadHooks = {}): Promise<ColdLoadResult> {
  const common = { engine: cfg.engine, compactEveryUpdates: 100, idleEvictMs: 300, sweepMs: 100 };
  let gw = await world.start(common);
  const docId = "load-cold";
  const rand = rng(cfg.seed);
  const chunkChars = Math.ceil(cfg.snapshotBytes / cfg.chunks);
  const filler = await GatewayClient.connect({ url: gw.url, docId, actor: 1, key: world.keys[0]!, engine: cfg.engine });
  const t0 = now();
  let expected = 0;
  let snapshotBytes = 0;
  try {
    let pending: Promise<void>[] = [];
    for (let i = 0; i < cfg.chunks; i++) {
      let s = "";
      for (let j = 0; j < chunkChars; j++) s += String.fromCharCode(97 + Math.floor(rand() * 26));
      pending.push(filler.insert(expected, s));
      expected += s.length;
      if (pending.length >= 20) {
        await Promise.all(pending);
        pending = [];
      }
    }
    await Promise.all(pending);
    snapshotBytes = filler.doc.snapshot().length;
    await until(() => gw.logs.some((l) => l.event === "snapshot_written" && Number(l.fields["bytes"]) >= snapshotBytes * 0.99), 60_000, "the snapshot of the full document");
    await hooks.afterFill?.(filler);
  } finally {
    await filler.close();
  }
  const fillSeconds = r2((now() - t0) / 1000);
  log(`filled ${expected} characters, snapshot ${snapshotBytes} bytes, in ${fillSeconds} s`);
  const evicted = async (p: GatewayProcess) => {
    const end = now() + 10_000;
    while (Number((await p.stats())["documents"]) !== 0) {
      if (now() > end) throw new Error("the document was not evicted");
      await sleep(50);
    }
  };

  const loadOnce = async (p: GatewayProcess): Promise<number> => {
    log("connecting");
    const r = await coldSync({ url: p.url, docId, actor: 2, engine: cfg.engine, timeoutMs: 60_000 });
    if (r.textLength !== expected) throw new Error(`cold load returned ${r.textLength} characters, expected ${expected}`);
    return r.ms;
  };

  await evicted(gw);
  log("evicted; loading");
  const times: number[] = [];
  for (let i = 0; i < cfg.rounds; i++) {
    times.push(await loadOnce(gw));
    log(`round ${i + 1}: ${r2(times[times.length - 1]!)} ms`);
    await evicted(gw);
  }
  const loads = gw.logs.filter((l) => l.event === "room_loaded" && l.fields["docId"] === docId);
  const lastLoad = loads[loads.length - 1];
  const loadedFrom = lastLoad ? { snapshotVersion: Number(lastLoad.fields["snapshotVersion"]), replayed: Number(lastLoad.fields["replayed"]) } : undefined;
  // Can the stock client load it? One attempt, no retries.
  const stock = await GatewayClient.connect({ url: gw.url, docId, actor: 3, key: world.keys[1]!, engine: cfg.engine, reconnect: false, syncTimeoutMs: 8000 }).then(
    async (c) => {
      const got = c.doc.getText().length;
      await c.close();
      // "Syncs" means it holds the whole document, not merely that the handshake finished.
      return got === expected ? { syncs: true, detail: "synced" } : { syncs: false, detail: `synced ${got} characters, expected ${expected}` };
    },
    (e: Error) => ({ syncs: false, detail: e.message }),
  );
  log(`stock client: ${stock.syncs ? "syncs" : `does not sync (${stock.detail})`}`);
  // A fresh process on the same store: nothing warm at all. The in-memory store dies with its process, so only PostgreSQL can do this.
  let first: number | undefined;
  if (world.store.kind === "postgres") {
    await gw.stop();
    gw = await world.start(common);
    first = r2(await loadOnce(gw));
  }
  return {
    config: cfg,
    snapshotBytes,
    textLength: expected,
    clientMs: summarize(times),
    stockClient: stock,
    loadedFrom,
    roomLoads: loads.length,
    firstAfterProcessStartMs: first,
    fillSeconds,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// reconnect storm

export interface StormConfig {
  engine: EngineName;
  clients: number;
  partitionMs: number;
  offlineEdits: number;
  /** Live typing before the partition, to compare with. */
  baselineMs: number;
  liveEditsPerSecond: number;
  /** Give up on the storm after this long. */
  limitMs: number;
  /** Size of the document everyone has to catch up on, in KiB (0: a few bytes). Above 1 MiB needs the inbound cap of docs/specs/large-sync.md (ticket L1). */
  seedKb: number;
}

export interface StormResult {
  config: StormConfig;
  allBackMs: number | undefined;
  backMs: Summary | undefined;
  neverReturned: number;
  converged: boolean;
  live: { baseline: Summary | undefined; partition: Summary | undefined; storm: Summary | undefined; after: Summary | undefined };
  liveEdits: number;
  /** Characters in the document the swarm caught up on before the partition. */
  docChars: number;
  server: { persisted: number | undefined; busyRejections: number | undefined; rateLimited: number | undefined; connections: number | undefined };
  proxy: { accepted: number; refused: number };
  generator: { loopP99Ms: number; loopMaxMs: number };
}

export interface StormHooks {
  afterHeal?(proxy: PartitionProxy, ctx: { watcher: GatewayClient }): void;
  /** How long to wait for the watcher to receive every live edit (default 20 s). */
  drainMs?: number;
}

export async function reconnectStorm(world: World, cfg: StormConfig, hooks: StormHooks = {}): Promise<StormResult> {
  if (world.keys.length < cfg.clients + 2) throw new Error("the world needs clients + 2 keys");
  const gw = await world.start({ engine: cfg.engine });
  const proxy = new PartitionProxy({ host: "127.0.0.1", port: gw.port });
  await proxy.listen();
  const docId = "load-storm";
  const swarm: GatewayClient[] = [];
  let live: GatewayClient | undefined;
  let watcher: GatewayClient | undefined;
  const lag = new LoopLag();
  try {
    for (let i = 0; i < cfg.clients; i += 25) {
      const batch = [];
      for (let j = i; j < Math.min(i + 25, cfg.clients); j++) batch.push(GatewayClient.connect({ url: `ws://127.0.0.1:${proxy.port}`, docId, actor: j + 1, key: world.keys[j]!, engine: cfg.engine }));
      swarm.push(...(await Promise.all(batch)));
    }
    live = await GatewayClient.connect({ url: gw.url, docId, actor: cfg.clients + 1, key: world.keys[cfg.clients]!, engine: cfg.engine });
    watcher = await GatewayClient.connect({ url: gw.url, docId, actor: cfg.clients + 2, key: world.keys[cfg.clients + 1]!, engine: cfg.engine });
    const seedChunks = Math.ceil((cfg.seedKb * 1024) / 10_240);
    let seedLength = 0;
    for (let i = 0; i < seedChunks; i++) {
      const chunk = "s".repeat(10_240);
      await live.insert(seedLength, chunk);
      seedLength += chunk.length;
    }
    await live.insert(seedLength, "seed;");
    seedLength += 5;
    await until(() => swarm.every((c) => c.doc.getText().length === seedLength), 60_000, "the seed to reach every client");

    // Live editor and its watcher, direct to the gateway.
    const sent = new Map<string, number>();
    const samples: Timed[] = [];
    let liveEdits = 0;
    let received = 0;
    stamp(live, (u, t0) => void sent.set(updateKey(u), t0));
    watcher.onRemoteUpdate((u) => {
      const t0 = sent.get(updateKey(u));
      if (t0 === undefined) return;
      received++;
      samples.push({ at: now(), ms: now() - t0 });
    });
    let typing = true;
    const gap = 1000 / cfg.liveEditsPerSecond;
    const liveLoop = (async () => {
      let due = now();
      while (typing) {
        due += gap;
        const wait = due - now();
        if (wait > 0) await sleep(wait);
        void live!.insert(live!.doc.getText().length, "l");
        liveEdits++;
      }
    })();

    lag.start();
    await sleep(cfg.baselineMs);
    const tPartition = now();
    proxy.partition();
    await until(() => swarm.every((c) => !c.connected), 10_000, "every client to notice the partition");
    const lastAck = new Array<number | undefined>(cfg.clients).fill(undefined);
    const offline = swarm.map((c, i) => {
      let last: Promise<void> = Promise.resolve();
      for (let k = 0; k < cfg.offlineEdits; k++) {
        const m = `[${i}.${k}]`;
        last = c.insert(c.doc.getText().length, m);
      }
      return last.then(() => void (lastAck[i] = now()));
    });
    await sleep(cfg.partitionMs);
    const tHeal = now();
    proxy.heal();
    hooks.afterHeal?.(proxy, { watcher: watcher! });
    const settled = Promise.allSettled(offline);
    const limit = new Promise<"limit">((r) => setTimeout(() => r("limit"), cfg.limitMs).unref());
    await Promise.race([settled, limit]);
    const returned = lastAck.filter((t): t is number => t !== undefined);
    const neverReturned = cfg.clients - returned.length;
    const tAllBack = neverReturned === 0 ? Math.max(...returned) : undefined;

    // Everyone converges on the same text, with every offline edit in it.
    const settleText = async () => {
      const end = now() + 60_000;
      for (;;) {
        const texts = new Set(swarm.map((c) => c.doc.getText()));
        // Every client keeps its own edits locally, so an offline edit the gateway lost would leave the texts different.
        if (texts.size === 1) return true;
        if (now() > end) return false;
        await sleep(100);
      }
    };
    const tAfterStart = now();
    await sleep(Math.max(0, 2000 - (now() - (tAllBack ?? tAfterStart)))); // a little live typing after the storm
    typing = false;
    await liveLoop;
    await until(() => received >= liveEdits, hooks.drainMs ?? 20_000, "the watcher to receive every live edit").catch(() => {
      throw new Error(`live edits were lost: the watcher received ${received} of ${liveEdits}`);
    });
    const converged = neverReturned === 0 ? await settleText() : false;
    const gen = lag.stop();
    const text = await gw.scrape();

    const part = (from: number, to: number) => {
      const xs = samples.filter((s) => s.at >= from && s.at < to).map((s) => s.ms);
      return xs.length > 0 ? summarize(xs) : undefined;
    };
    const tStormEnd = tAllBack ?? now();
    const back = returned.map((t) => t - tHeal);
    return {
      config: cfg,
      allBackMs: tAllBack === undefined ? undefined : Math.round(tAllBack - tHeal),
      backMs: back.length > 0 ? summarize(back) : undefined,
      neverReturned,
      converged,
      live: { baseline: part(0, tPartition), partition: part(tPartition, tHeal), storm: part(tHeal, tStormEnd), after: part(tStormEnd, Infinity) },
      liveEdits,
      docChars: seedLength,
      server: {
        persisted: sampleValue(text, "omnisync_updates_total", { outcome: "persisted" }),
        busyRejections: sampleValue(text, "omnisync_admission_rejections_total", { reason: "busy" }),
        rateLimited: sampleValue(text, "omnisync_admission_rejections_total", { reason: "rate_limited" }),
        connections: sampleValue(text, "omnisync_connections_active"),
      },
      proxy: { accepted: proxy.accepted, refused: proxy.refused },
      generator: { loopP99Ms: gen.p99Ms, loopMaxMs: gen.maxMs },
    };
  } finally {
    lag.stop();
    await Promise.all([...swarm.map((c) => c.close()), live?.close(), watcher?.close()]);
    await proxy.close();
  }
}
