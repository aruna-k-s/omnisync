import { afterEach, describe, expect, it } from "vitest";
import { coldLoad, editLatency, memory, reconnectStorm } from "../src/load/scenarios.js";
import { makeWorld, type World } from "../src/load/world.js";

const DB = process.env["OMNISYNC_TEST_DATABASE_URL"];
const STORES: [string, string | undefined][] = [["memory", undefined], ...(DB ? [["postgres", DB] as [string, string]] : [])];
const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.cleanup();
});
async function world(keys: number, databaseUrl?: string): Promise<World> {
  const w = await makeWorld({ databaseUrl, keys, engine: "yjs" });
  worlds.push(w);
  return w;
}

const edit = { engine: "yjs", editors: 8, typists: 3, ratePerTypist: 20, seconds: 3, probes: 2, minWarmupMs: 300, seed: 1 } as const;

describe.each(STORES)("edit latency (%s store)", (_name, url) => {
  it("measures edits from the sender's edit to a different client's apply, and nothing is lost", async () => {
    const r = await editLatency(await world(8, url), edit);
    expect(r.edits).toBeGreaterThan(60);
    expect(r.server.persisted).toBe(r.edits);
    expect(r.latencyMs.count).toBeGreaterThan(r.edits); // two probes, minus their own edits and the warm-up
    expect(r.latencyMs.count).toBeLessThanOrEqual(r.edits * 2);
    expect(r.latencyMs.p50).toBeGreaterThan(0.2); // a loopback hop, a signature and an apply cannot take less
    expect(r.latencyMs.max).toBeGreaterThan(r.latencyMs.min);
    expect(r.latencyMs.p99).toBeGreaterThan(0);
    expect(r.latencyMs.p99).toBeLessThan(5000);
    expect(r.latencyMs.min).toBeGreaterThanOrEqual(0);
    expect(r.ackMs?.count).toBeGreaterThan(0);
    expect(r.samplesDiscarded).toBeGreaterThan(0);
    expect(r.warmupMs).toBeGreaterThanOrEqual(300);
    expect(r.generator.loopP99Ms).toBeGreaterThanOrEqual(0);
    expect(r.server.applyP99S).toBeGreaterThan(0);
    expect(r.server.ledgerAppendP99S).toBeGreaterThan(0);
    expect(r.server.fanoutP99S).toBeGreaterThan(0);
    expect(r.editsPerSecond).toBeGreaterThan(20);
    expect(r.editsPerSecond).toBeLessThan(100); // 3 typists at 20/s
  }, 60_000);

  it("fails when a probe stops receiving part-way, even though it received most of what was sent", async () => {
    await expect(
      editLatency(await world(8, url), edit, {
        drainMs: 800,
        afterConnect: ({ probes }) => void setTimeout(() => void probes[0]!.close(), 2000), // two thirds of the way through the typing
      }),
    ).rejects.toThrow(/edits were lost/);
  }, 60_000);

  it("fails when a typist's edits are never acknowledged", async () => {
    await expect(
      editLatency(await world(8, url), edit, {
        drainMs: 800,
        afterConnect: ({ raws }) => {
          raws[0]!.trackAcks = () => {}; // its ACKs are never read, so its edits stay unacknowledged
        },
      }),
    ).rejects.toThrow(/edits were lost/);
  }, 60_000);

  it("fails, naming the loss, when a probe never receives an edit", async () => {
    await expect(
      editLatency(await world(8, url), edit, { drainMs: 800, afterConnect: ({ probes }) => void probes[0]!.close() }),
    ).rejects.toThrow(/edits were lost/);
  }, 60_000);
});

describe("edit latency, shapes", () => {
  it("every editor can type (the worst-case profile) and probes' own edits are not counted as received", async () => {
    const r = await editLatency(await world(6), { ...edit, editors: 6, typists: 6, ratePerTypist: 10 });
    expect(r.server.persisted).toBe(r.edits);
    expect(r.latencyMs.count).toBeLessThanOrEqual(r.edits * 2);
  }, 60_000);
  it("refuses impossible shapes before starting anything", async () => {
    const w = await world(4);
    await expect(editLatency(w, { ...edit, editors: 4, probes: 0 })).rejects.toThrow(/probes/);
    await expect(editLatency(w, { ...edit, editors: 4, typists: 5 })).rejects.toThrow(/typists/);
    await expect(editLatency(w, { ...edit, editors: 5 })).rejects.toThrow(/keys/);
  });
});

describe("memory", () => {
  it("reports growth that rises with the operations, and checks what the gateway persisted", async () => {
    const small = await memory(await world(1), { engine: "yjs", ops: 1000, seed: 42, window: 200 });
    const big = await memory(await world(1), { engine: "yjs", ops: 20_000, seed: 42, window: 200 });
    expect(small.documentsResident).toBe(1);
    expect(big.textLength).toBeGreaterThan(small.textLength);
    expect(big.heapGrowthMb).toBeGreaterThan(small.heapGrowthMb);
    expect(big.rssAfterMb).toBeGreaterThan(0);
    expect(big.rssGrowthMb).toBeCloseTo(big.rssAfterMb - big.rssBeforeMb, 1);
    expect(big.opsPerSecond).toBeGreaterThan(100);
    expect(big.snapshotsWritten).toBeGreaterThan(10);
  }, 120_000);
});

describe("memory, failure paths", () => {
  it("refuses a run in which the gateway persisted something other than the operations it was sent", async () => {
    await expect(memory(await world(1), { engine: "yjs", ops: 300, seed: 42, window: 100 }, { afterFill: async ({ client }) => { await client.insert(0, "x"); await client.delete(0, 1); } })).rejects.toThrow(/persisted 302 of 300/);
  }, 60_000);
  it("refuses a run in which the client's document is not the one the trace implies", async () => {
    await expect(memory(await world(1), { engine: "yjs", ops: 300, seed: 42, window: 100 }, { afterFill: ({ client }) => void client.doc.insertText(0, "local only") })).rejects.toThrow(/length the trace implies/);
  }, 60_000);
});

describe("cold load", () => {
  it("loads the document back from its snapshot, byte for byte in length, and reports the spread", async () => {
    const r = await coldLoad(await world(2), { engine: "yjs", snapshotBytes: 200_000, chunks: 100, rounds: 3, seed: 3 });
    expect(r.textLength).toBe(200_000);
    expect(r.snapshotBytes).toBeGreaterThanOrEqual(200_000);
    expect(r.clientMs.count).toBe(3);
    expect(r.clientMs.p95).toBeGreaterThan(0);
    expect(r.stockClient.syncs).toBe(true);
    expect(r.roomLoads).toBe(1 + 3); // the fill and three rounds: every round really loaded from the store
    expect(r.loadedFrom?.snapshotVersion).toBeGreaterThan(0);
    expect(r.loadedFrom?.replayed).toBe(0); // from the snapshot alone, no log replay
    expect(r.firstAfterProcessStartMs).toBeUndefined(); // the in-memory store cannot outlive its process
  }, 120_000);

  // Ticket L1 (docs/specs/load.md): GatewayClient decodes frames with the default 1 MiB cap, so it silently drops a larger
  // SYNC_2 and can never open a bigger document. This test records the defect; when the client is fixed it fails, and
  // the fix is to flip the expectation and close the ticket.
  it("refuses a load that returns a different document from the one written", async () => {
    await expect(
      coldLoad(await world(2), { engine: "yjs", snapshotBytes: 100_000, chunks: 100, rounds: 1, seed: 3 }, () => {}, { afterFill: (c) => c.delete(0, 1) }),
    ).rejects.toThrow(/cold load returned \d+ characters, expected 100000/);
  }, 120_000);

  it("documents the known limit: the stock client cannot load a document over 1 MiB, while the gateway serves it", async () => {
    const r = await coldLoad(await world(2), { engine: "yjs", snapshotBytes: 2 * 1024 * 1024, chunks: 100, rounds: 1, seed: 3 });
    expect(r.textLength).toBe(Math.ceil((2 * 1024 * 1024) / 100) * 100);
    expect(r.stockClient.syncs).toBe(false);
    expect(r.clientMs.count).toBe(1);
  }, 120_000);

  it.runIf(DB)("also loads in a fresh process from PostgreSQL and the snapshot directory", async () => {
    const r = await coldLoad(await world(2, DB), { engine: "yjs", snapshotBytes: 200_000, chunks: 100, rounds: 2, seed: 3 });
    expect(r.textLength).toBe(200_000);
    expect(r.firstAfterProcessStartMs).toBeGreaterThan(0);
  }, 120_000);
});

describe.each(STORES)("reconnect storm (%s store)", (_name, url) => {
  const cfg = { engine: "yjs", clients: 6, partitionMs: 800, offlineEdits: 2, baselineMs: 600, liveEditsPerSecond: 10, limitMs: 30_000, seedKb: 0 } as const;
  it("brings every client back with its offline edits and converges, while the live editor keeps going", async () => {
    const r = await reconnectStorm(await world(8, url), cfg);
    expect(r.neverReturned).toBe(0);
    expect(r.converged).toBe(true);
    expect(r.allBackMs).toBeGreaterThan(0);
    expect(r.backMs?.count).toBe(6);
    expect(r.proxy.accepted).toBeGreaterThanOrEqual(12); // the first connections and the reconnections
    expect(r.live.baseline?.count).toBeGreaterThan(3);
    expect(r.live.partition?.count).toBeGreaterThan(3);
    expect(r.liveEdits).toBeGreaterThan(10);
    expect(Math.abs(r.allBackMs! - r.backMs!.max)).toBeLessThan(2); // all back = the last client back
    expect(r.docChars).toBe(5); // the seed marker only
    expect(r.server.persisted).toBeGreaterThanOrEqual(1 + r.liveEdits + 6 * 2); // the seed, the live edits, every offline edit
    expect(r.server.connections).toBe(8); // the swarm, the live editor and its watcher
  }, 120_000);

  it("catches every client up on a document of the size asked for, and says how many busy refusals it saw", async () => {
    const r = await reconnectStorm(await world(8, url), { ...cfg, seedKb: 60 });
    expect(r.neverReturned).toBe(0);
    expect(r.converged).toBe(true);
    expect(r.config.seedKb).toBe(60);
    expect(r.docChars).toBeGreaterThanOrEqual(60 * 1024);
    expect(r.server.busyRejections).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it("fails when the live editor's edits stop reaching its watcher", async () => {
    await expect(reconnectStorm(await world(8, url), cfg, { drainMs: 1000, afterHeal: (_proxy, { watcher }) => void watcher.close() })).rejects.toThrow(/live edits were lost/);
  }, 120_000);

  it("reports clients that never return, and does not claim convergence", async () => {
    const r = await reconnectStorm(await world(8, url), { ...cfg, limitMs: 1500 }, { afterHeal: (proxy) => proxy.partition() });
    expect(r.neverReturned).toBe(6);
    expect(r.allBackMs).toBeUndefined();
    expect(r.backMs).toBeUndefined();
    expect(r.converged).toBe(false);
  }, 120_000);
});
