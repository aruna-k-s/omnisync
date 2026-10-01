/**
 * Phase 0 benchmark harness: engine spike + signing cost + end-to-end latency.
 *
 *   pnpm bench                          # all engines, default sizes
 *   BENCH_OPS=100000 pnpm bench         # the 100,000-operation memory target
 *   BENCH_ENGINES=yjs,loro pnpm bench
 *
 * Writes raw results to bench/results/<timestamp>.json so decisions cite data.
 * Targets (spec, "Benchmark targets"): p99 keystroke-to-remote < 100 ms with
 * 100 editors; < 50 MB gateway memory per document at 100k ops; cold load
 * p95 < 500 ms for a 10 MB snapshot.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { engines, getEngine, type EngineDoc, type EngineName } from "@omnisync/engine";
import { Keyring, generateKeyPair, signUpdate, verifyUpdate } from "@omnisync/protocol";
import { Gateway, GatewayClient } from "@omnisync/gateway";

const OPS = Number(process.env.BENCH_OPS ?? 20_000);
const EDITORS = Number(process.env.BENCH_EDITORS ?? 20);
const EDITS_PER_EDITOR = Number(process.env.BENCH_EDITS ?? 50);
const ENGINES = (process.env.BENCH_ENGINES?.split(",") ?? Object.keys(engines)) as EngineName[];

/** Deterministic PRNG so every run replays the same editing trace. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Typing trace: mostly appends near a moving cursor, ~10% deletions. */
function typingTrace(doc: EngineDoc, n: number, seed: number): Uint8Array[] {
  const rand = rng(seed);
  const updates: Uint8Array[] = [];
  let cursor = 0;
  let len = doc.getText().length; // tracked locally: reading the text each op would dominate the timing
  for (let i = 0; i < n; i++) {
    if (rand() < 0.05) cursor = Math.floor(rand() * (len + 1));
    cursor = Math.min(cursor, len);
    if (rand() < 0.1 && cursor > 0) {
      updates.push(doc.deleteText(cursor - 1, 1));
      cursor--;
      len--;
    } else {
      updates.push(doc.insertText(cursor, String.fromCharCode(97 + Math.floor(rand() * 26))));
      cursor++;
      len++;
    }
  }
  return updates;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? NaN;
};
const mb = (b: number) => b / 1024 / 1024;
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const gc = () => (globalThis as { gc?: () => void }).gc?.();

interface EngineResult {
  engine: EngineName;
  ops: number;
  localOpUs: number;
  avgUpdateBytes: number;
  applyAllMs: number;
  snapshotBytes: number;
  coldLoadMs: number;
  memoryMb: number;
}

function benchEngine(name: EngineName): EngineResult {
  const engine = getEngine(name);
  gc();
  const memBefore = process.memoryUsage();
  const author = engine.create(1);
  const t0 = performance.now();
  const updates = typingTrace(author, OPS, 42);
  const localMs = performance.now() - t0;

  const replica = engine.create(2);
  const t1 = performance.now();
  for (const u of updates) replica.applyUpdate(u);
  const applyAllMs = performance.now() - t1;
  if (replica.getText() !== author.getText()) throw new Error(`${name}: replica diverged`);

  gc();
  const memAfter = process.memoryUsage();
  const snapshot = replica.snapshot();
  const loads: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    const loaded = engine.load(snapshot, 3 + i);
    loaded.getText();
    loads.push(performance.now() - t);
    loaded.destroy();
  }
  const result: EngineResult = {
    engine: name,
    ops: OPS,
    localOpUs: round((localMs * 1000) / OPS),
    avgUpdateBytes: round(updates.reduce((s, u) => s + u.length, 0) / updates.length, 1),
    applyAllMs: round(applyAllMs),
    snapshotBytes: snapshot.length,
    coldLoadMs: round(pct(loads, 95)),
    // RSS includes WASM heaps (Automerge, Loro); two replicas are alive here.
    memoryMb: round(mb(memAfter.rss - memBefore.rss)),
  };
  author.destroy();
  replica.destroy();
  return result;
}

function benchSigning() {
  const key = generateKeyPair();
  const ring = new Keyring();
  ring.add(key.publicKey);
  const payload = new Uint8Array(200);
  const n = 2000;
  const frames: Uint8Array[] = [];
  const t0 = performance.now();
  for (let i = 0; i < n; i++) frames.push(signUpdate({ docId: "bench", sessionId: 1, seq: i + 1, payload }, key));
  const t1 = performance.now();
  for (const f of frames) if (!verifyUpdate(f, "bench", ring.resolve).ok) throw new Error("verify failed");
  const t2 = performance.now();
  return {
    signUs: round(((t1 - t0) * 1000) / n),
    verifyUs: round(((t2 - t1) * 1000) / n),
    overheadBytes: (frames[0]?.length ?? 0) - payload.length,
  };
}

async function benchEndToEnd(name: EngineName) {
  const ring = new Keyring();
  const keys = Array.from({ length: EDITORS }, () => generateKeyPair());
  keys.forEach((k) => ring.add(k.publicKey));
  const gateway = new Gateway({ engine: name, resolveKey: ring.resolve });
  const url = `ws://127.0.0.1:${await gateway.listen()}`;
  const clients = await Promise.all(
    keys.map((key, i) => GatewayClient.connect({ url, docId: "e2e", actor: i + 1, key, engine: name })),
  );

  // Observer measures time from an editor's send to receipt.
  const observer = clients[0] as GatewayClient;
  const latencies: number[] = [];
  let pendingStart = 0;
  let received = 0;
  observer.onRemoteUpdate(() => {
    received++;
    if (pendingStart) latencies.push(performance.now() - pendingStart);
    pendingStart = 0;
  });

  const rand = rng(7);
  for (let i = 0; i < EDITS_PER_EDITOR; i++) {
    for (const c of clients.slice(1)) {
      pendingStart = performance.now();
      const before = received;
      await c.insert(Math.floor(rand() * (c.doc.getText().length + 1)), "x");
      while (received === before) await new Promise((r) => setImmediate(r));
    }
  }
  await Promise.all(clients.map((c) => c.sync()));
  const texts = new Set(clients.map((c) => c.doc.getText()));
  const result = {
    engine: name,
    editors: EDITORS,
    edits: latencies.length,
    p50Ms: round(pct(latencies, 50)),
    p99Ms: round(pct(latencies, 99)),
    converged: texts.size === 1,
  };
  await Promise.all(clients.map((c) => c.close()));
  await gateway.close();
  return result;
}

const results = {
  at: new Date().toISOString(),
  node: process.version,
  config: { OPS, EDITORS, EDITS_PER_EDITOR, ENGINES },
  engines: [] as EngineResult[],
  signing: benchSigning(),
  endToEnd: [] as Awaited<ReturnType<typeof benchEndToEnd>>[],
};

for (const e of ENGINES) results.engines.push(benchEngine(e));
for (const e of ENGINES) results.endToEnd.push(await benchEndToEnd(e));

console.log(`\nEngine spike: ${OPS.toLocaleString()} typing ops, one author, one replica`);
console.table(results.engines);
console.log("Signed envelope cost (200-byte payload)");
console.table([results.signing]);
console.log(`End to end through the gateway: ${EDITORS} editors, sequential edits, observer latency`);
console.table(results.endToEnd);

mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
const file = new URL(`../results/${results.at.replace(/[:.]/g, "-")}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(results, null, 2));
console.log(`raw results: ${file.pathname}`);
