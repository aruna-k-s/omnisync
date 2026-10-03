import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { FrameType, decodeFrame, encodeFrame } from "@omnisync/protocol";
import type { GatewayClient } from "../src/index.js";
import { PG_URL, connectClient, makeWorld, startGateway, until, type Running, type StoreKind, type World } from "./harness.js";

const kinds: StoreKind[] = PG_URL ? ["memory", "postgres"] : ["memory"];

describe.each(kinds)("gateway hardening on %s store", (kind) => {
  let world: World;
  const running: Running[] = [];
  const clients: GatewayClient[] = [];
  const start = async (opts: Parameters<typeof startGateway>[1] = {}) => {
    const r = await startGateway(world, opts);
    running.push(r);
    return r;
  };
  const connect = async (r: Running, actor: number) => {
    const c = await connectClient(r.url, actor);
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

  it("rejects a snapshot object that is valid CRDT state but not the state its checksum names", async () => {
    const g1 = await start({ compactEveryUpdates: 3 });
    const a = await connect(g1, 1);
    for (let i = 0; i < 9; i++) await a.insert(a.doc.getText().length, `e${i};`);
    await g1.gateway.close();
    const [newest, older] = await world.store.listSnapshots("doc", 2);
    expect(newest!.upToSeq).toBeGreaterThan(older!.upToSeq);
    // A perfectly loadable but stale snapshot swapped in under the newest name: only the checksum can tell.
    world.objects.corrupt.set(newest!.objectKey, (await world.rawObjects.get(older!.objectKey))!);

    const g2 = await start();
    const b = await connect(g2, 2);
    expect(b.doc.getText()).toBe(a.doc.getText());
    expect(g2.gateway.stats.snapshotFallbacks).toBe(1);
  });

  it("does not echo an author's own update back to them", async () => {
    const r = await start();
    const a = await connect(r, 1);
    const b = await connect(r, 2);
    let aSaw = 0;
    let bSaw = 0;
    a.onRemoteUpdate(() => aSaw++);
    b.onRemoteUpdate(() => bSaw++);
    await a.insert(0, "x");
    await until(() => bSaw === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(aSaw).toBe(0);
    expect(bSaw).toBe(1);
  });

  it("a hung object store cannot wedge snapshots, cold load or shutdown", async () => {
    const g1 = await start({ compactEveryUpdates: 2, objectTimeoutMs: 100 });
    const a = await connect(g1, 1);
    await a.insert(0, "one;");
    await a.insert(4, "two;"); // snapshot succeeds
    await until(() => g1.gateway.stats.snapshots === 1);
    world.objects.hang = true;
    await a.insert(8, "three;");
    await a.insert(14, "four;"); // snapshot attempt hangs, then times out
    await until(() => g1.gateway.stats.snapshotFailures >= 1, 3000, "snapshot timeout");
    const t0 = Date.now();
    await g1.gateway.close();
    expect(Date.now() - t0).toBeLessThan(2500);

    // Cold load: the snapshot read hangs, times out, and the log rebuilds the document.
    const g2 = await start({ objectTimeoutMs: 100 });
    const b = await connect(g2, 2);
    expect(b.doc.getText()).toBe("one;two;three;four;");
    expect(g2.gateway.stats.snapshotFallbacks).toBeGreaterThan(0);
  });

  it("caps AWARENESS payloads and still relays small ones", async () => {
    const r = await start({ maxAwarenessBytes: 64 });
    const peer = await new Promise<WebSocket>((resolve) => {
      const ws = new WebSocket(`${r.url}/doc/doc`);
      ws.on("open", () => resolve(ws));
    });
    const sender = await new Promise<WebSocket>((resolve) => {
      const ws = new WebSocket(`${r.url}/doc/doc`);
      ws.on("open", () => resolve(ws));
    });
    const received: number[] = [];
    peer.on("message", (d: Buffer) => {
      const f = decodeFrame(new Uint8Array(d));
      if (f.type === FrameType.AWARENESS) received.push(f.payload.length);
    });
    const errors: string[] = [];
    sender.on("message", (d: Buffer) => {
      const f = decodeFrame(new Uint8Array(d));
      if (f.type === FrameType.ERROR) errors.push(new TextDecoder().decode(f.payload));
    });
    const aw = (n: number) => encodeFrame({ type: FrameType.AWARENESS, flags: 0, sessionId: 1, seq: 0, payload: new Uint8Array(n) });
    sender.send(aw(10));
    sender.send(aw(65));
    await until(() => received.length === 1 && errors.length === 1);
    expect(received).toEqual([10]);
    expect(errors).toEqual(["awareness_too_large"]);
    peer.close();
    sender.close();
  });

  it("refuses browser origins unless allowed, and never affects clients without an Origin", async () => {
    const closed = await start();
    const attempt = (url: string, origin: string) =>
      new Promise<number | "open">((resolve) => {
        const ws = new WebSocket(`${url}/doc/doc`, { origin });
        ws.on("open", () => (ws.close(), resolve("open")));
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.on("error", () => {});
      });
    expect(await attempt(closed.url, "https://evil.example")).toBe(403);
    await connect(closed, 1); // no Origin header: allowed

    const open = await start({ allowedOrigins: ["https://app.example"] });
    expect(await attempt(open.url, "https://app.example")).toBe("open");
    expect(await attempt(open.url, "https://evil.example")).toBe(403);

    const any = await start({ allowedOrigins: "*" });
    expect(await attempt(any.url, "https://whatever.example")).toBe("open");
  });
});
