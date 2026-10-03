import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { engines, type EngineName } from "@omnisync/engine";
import { FrameType, decodeFrame, encodeFrame, signUpdate } from "@omnisync/protocol";
import { snapshotObjectKey } from "@omnisync/store";
import type { GatewayClient } from "../src/index.js";
import { PG_URL, connectClient, keys, makeWorld, sleep, startGateway, until, type Running, type StoreKind, type World } from "./harness.js";

const kinds: StoreKind[] = PG_URL ? ["memory", "postgres"] : ["memory"];

describe.each(kinds)("gateway durability on %s store", (kind) => {
  let world: World;
  const running: Running[] = [];
  const clients: GatewayClient[] = [];

  const start = async (opts: Parameters<typeof startGateway>[1] = {}) => {
    const r = await startGateway(world, opts);
    running.push(r);
    return r;
  };
  const connect = async (r: Running, actor: number, engine: EngineName = "yjs", docId = "doc") => {
    const c = await connectClient(r.url, actor, engine, { docId });
    clients.push(c);
    return c;
  };

  beforeEach(async () => {
    world = await makeWorld(kind);
  });

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((c) => c.close()));
    await Promise.allSettled(running.splice(0).map((r) => r.gateway.close()));
    await world.cleanup();
  });

  for (const engine of Object.keys(engines) as EngineName[]) {
    it(`[${engine}] every acknowledged edit survives a graceful restart, and a retried frame stays idempotent`, async () => {
      const g1 = await start({ engine });
      const a = await connect(g1, 1, engine);
      await a.insert(0, "hello");
      await a.insert(5, " world");
      await a.delete(0, 1);
      expect(a.doc.getText()).toBe("ello world");
      await a.close();
      await g1.gateway.close();

      const g2 = await start({ engine });
      const b = await connect(g2, 2, engine);
      expect(b.doc.getText()).toBe("ello world");
      expect(g2.gateway.stats.loads).toBe(1);

      // The same signed frame again (a client that lost its ACK before the restart): acknowledged, not re-applied.
      const frame = signUpdate({ docId: "doc", sessionId: 77, claimedAtMs: 0, seq: 1, payload: b.doc.insertText(0, "!") }, keys[2]!);
      b.sendRaw(frame);
      b.sendRaw(frame);
      await until(() => g2.gateway.stats.duplicates === 1);
      await g2.gateway.close();
      const g3 = await start({ engine });
      const c = await connect(g3, 3, engine);
      expect(c.doc.getText()).toBe("!ello world");
      c.sendRaw(frame); // replay protection lives in the store, so it survives the restart
      await until(() => g3.gateway.stats.duplicates === 1, 3000, "duplicate after restart");
      expect(g3.gateway.textOf("doc")).toBe("!ello world");
    });
  }

  it("kill -9: every edit that was acknowledged before the crash is present after restart", async () => {
    const g1 = await start();
    const writers = await Promise.all([1, 2, 3].map((n) => connect(g1, n)));
    const acked: string[] = [];
    for (const [w, c] of writers.entries()) {
      for (let i = 0; i < 40; i++) {
        const token = `<${w}:${i}>`;
        void c.insert(c.doc.getText().length, token).then(
          () => acked.push(token),
          () => {},
        );
      }
    }
    await until(() => acked.length >= 30, 5000, "some acks");
    await g1.gateway.crash();
    const countAtCrash = acked.length;

    const g2 = await start();
    const reader = await connect(g2, 4);
    const text = reader.doc.getText();
    for (const token of acked.slice(0, countAtCrash)) expect(text, `lost acked edit ${token}`).toContain(token);
    expect(await world.store.headSeq("doc")).toBeGreaterThanOrEqual(countAtCrash);
  });

  it("store down: the edit is neither applied, relayed nor acknowledged, stays queued, and lands after recovery", async () => {
    const r = await start();
    const a = await connect(r, 1);
    const b = await connect(r, 2);
    await a.insert(0, "before");
    await until(() => b.doc.getText() === "before");

    world.store.down = true;
    let delivered = false;
    const pending = a.insert(6, " during-outage").then(() => (delivered = true));
    await until(() => a.errors.includes("unavailable"), 3000, "unavailable error");
    expect(delivered).toBe(false);
    expect(r.gateway.textOf("doc")).toBe("before"); // no phantom state
    expect(b.doc.getText()).toBe("before"); // not relayed
    expect(r.gateway.stats.degraded).toBe(true);
    expect((await fetch(`http://127.0.0.1:${r.port}/readyz`)).status).toBe(503);

    // Reads keep working: a late joiner still syncs the committed state.
    expect((await connect(r, 3)).doc.getText()).toBe("before");

    world.store.down = false;
    await pending;
    await until(() => b.doc.getText() === "before during-outage");
    expect(r.gateway.stats.degraded).toBe(false);
    expect((await fetch(`http://127.0.0.1:${r.port}/readyz`)).status).toBe(200);
    expect(await world.store.headSeq("doc")).toBe(2);
  });

  it("group commit: concurrent edits share transactions", async () => {
    const r = await start();
    const writers = await Promise.all([1, 2, 3, 4].map((n) => connect(r, n)));
    world.store.delayMs = 15; // a realistic round trip lets the queue build up
    const before = world.store.calls;
    await Promise.all(writers.flatMap((c, w) => Array.from({ length: 25 }, (_, i) => c.insert(c.doc.getText().length, `[${w}.${i}]`))));
    const appends = world.store.calls - before;
    expect(await world.store.headSeq("doc")).toBe(100);
    expect(appends).toBeLessThan(40);
    world.store.delayMs = 0;
  });

  describe("snapshots and cold load", () => {
    const edit = async (c: GatewayClient, n: number) => {
      for (let i = 0; i < n; i++) await c.insert(c.doc.getText().length, `e${i};`);
    };

    it("compacts after N updates and cold-loads from the snapshot plus the tail", async () => {
      const events: { event: string; fields?: Record<string, unknown> }[] = [];
      const log = (event: string, fields?: Record<string, unknown>) => events.push({ event, ...(fields ? { fields } : {}) });
      const g1 = await start({ compactEveryUpdates: 10, log });
      const a = await connect(g1, 1);
      await edit(a, 25);
      await until(() => g1.gateway.stats.snapshots >= 2, 3000, "two snapshots");
      const expected = a.doc.getText();
      await a.close();
      await g1.gateway.close();

      const snaps = await world.store.listSnapshots("doc", 10);
      expect(snaps.length).toBeGreaterThanOrEqual(2);
      expect(snaps[0]!.upToSeq).toBeGreaterThan(snaps[1]!.upToSeq);
      for (const s of snaps) expect(await world.rawObjects.get(s.objectKey)).toBeDefined();

      events.length = 0;
      const g2 = await start({ log });
      const b = await connect(g2, 2);
      expect(b.doc.getText()).toBe(expected);
      const loaded = events.find((e) => e.event === "room_loaded")!.fields!;
      expect(loaded.snapshotVersion).toBeGreaterThan(0);
      expect(loaded.replayed as number).toBeLessThan(25); // the snapshot absorbed most of the log
    });

    for (const every of [1, 2, 5, 17]) {
      it(`snapshot cut is exact: threshold ${every} reloads to the identical text`, async () => {
        const g1 = await start({ compactEveryUpdates: every });
        const a = await connect(g1, 1);
        const b = await connect(g1, 2);
        // Interleaved writers so snapshots land in the middle of concurrent batches.
        await Promise.all([edit(a, 20), edit(b, 20)]);
        await until(() => a.doc.getText() === b.doc.getText() && a.doc.getText().length > 100, 5000, "convergence");
        const expected = g1.gateway.textOf("doc");
        expect(expected).toBe(a.doc.getText());
        await g1.gateway.close(); // drains and takes a final snapshot
        const g2 = await start();
        const c = await connect(g2, 3);
        expect(c.doc.getText()).toBe(expected);
      });
    }

    it("log completeness: with every snapshot object deleted, the log alone rebuilds the document", async () => {
      const g1 = await start({ compactEveryUpdates: 5 });
      const a = await connect(g1, 1);
      await edit(a, 20);
      await g1.gateway.close();
      const snaps = await world.store.listSnapshots("doc", 50);
      expect(snaps.length).toBeGreaterThan(0);
      for (const s of snaps) await world.rawObjects.delete(s.objectKey);

      const g2 = await start();
      const b = await connect(g2, 2);
      expect(b.doc.getText()).toBe(a.doc.getText());
      expect(g2.gateway.stats.snapshotFallbacks).toBeGreaterThan(0);
    });

    it("a corrupt newest snapshot falls back to the previous one", async () => {
      const g1 = await start({ compactEveryUpdates: 5 });
      const a = await connect(g1, 1);
      await edit(a, 20);
      await g1.gateway.close();
      const [newest] = await world.store.listSnapshots("doc", 1);
      world.objects.corrupt.set(newest!.objectKey, new Uint8Array([1, 2, 3, 4]));

      const g2 = await start();
      const b = await connect(g2, 2);
      expect(b.doc.getText()).toBe(a.doc.getText());
      expect(g2.gateway.stats.snapshotFallbacks).toBe(1);
    });

    it("object storage outage: editing continues, snapshots lag, then catch up after recovery", async () => {
      world.objects.down = true;
      const g = await start({ compactEveryUpdates: 5, compactRetryMs: 0 });
      const a = await connect(g, 1);
      await edit(a, 12);
      await until(() => g.gateway.stats.snapshotFailures >= 1, 3000, "snapshot failure");
      expect(g.gateway.stats.snapshots).toBe(0);
      expect(await world.store.headSeq("doc")).toBe(12); // writes were never blocked

      world.objects.down = false;
      await edit(a, 5);
      await until(() => g.gateway.stats.snapshots >= 1, 3000, "snapshot after recovery");
    });

    it("time-based compaction snapshots a quiet document with unsnapshotted updates", async () => {
      const g = await start({ compactEveryUpdates: 1000, compactEveryMs: 1000 });
      const a = await connect(g, 1);
      await edit(a, 3);
      await g.gateway.sweep(Date.now() + 500);
      expect(g.gateway.stats.snapshots).toBe(0);
      await g.gateway.sweep(Date.now() + 5000);
      expect(g.gateway.stats.snapshots).toBe(1);
      const [s] = await world.store.listSnapshots("doc", 1);
      expect(s!.upToSeq).toBe(3);
      expect(s!.objectKey).toBe(snapshotObjectKey("doc", 3, Buffer.from(s!.sha256).toString("hex")));
    });

    it("idle documents are snapshotted and evicted, and cold-load on the next connection", async () => {
      const g = await start({ idleEvictMs: 100 });
      const a = await connect(g, 1);
      await edit(a, 4);
      const expected = a.doc.getText();
      await a.close();
      await until(() => g.gateway.stats.connections === 0, 2000, "disconnect");

      await g.gateway.sweep(Date.now() + 10);
      expect(g.gateway.isResident("doc")).toBe(true); // not idle long enough yet
      await g.gateway.sweep(Date.now() + 5000);
      expect(g.gateway.isResident("doc")).toBe(false);
      expect(g.gateway.stats.evictions).toBe(1);
      expect(g.gateway.stats.snapshots).toBe(1); // final snapshot on eviction

      const b = await connect(g, 2);
      expect(b.doc.getText()).toBe(expected);
      expect(g.gateway.stats.loads).toBe(2);
    });

    it("a failed cold load closes the connection with 1013 and the next attempt succeeds", async () => {
      const g1 = await start();
      const a = await connect(g1, 1);
      await edit(a, 2);
      await g1.gateway.close();

      const g2 = await start();
      world.store.failNext = 1;
      const closed = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`${g2.url}/doc/doc`);
        ws.on("close", (code) => resolve(code));
      });
      expect(closed).toBe(1013);
      expect(g2.gateway.isResident("doc")).toBe(false);
      const b = await connect(g2, 2);
      expect(b.doc.getText()).toBe(a.doc.getText());
    });
  });

  it("answers `busy` with a retry hint when catch-up slots are exhausted", async () => {
    const r = await start({ maxConcurrentCatchUps: 0 });
    const reply = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`${r.url}/doc/doc`);
      ws.on("open", () => ws.send(encodeFrame({ type: FrameType.SYNC_1, flags: 0, sessionId: 1, seq: 0, payload: new Uint8Array() })));
      ws.on("message", (d: Buffer) => resolve(new TextDecoder().decode(decodeFrame(new Uint8Array(d)).payload)));
    });
    expect(reply).toMatch(/^busy;retry_after_ms=\d+$/);
    expect(r.gateway.stats.busyRejections).toBe(1);
    await sleep(0);
  });
});
