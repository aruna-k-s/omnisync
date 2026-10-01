import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { engines } from "@omnisync/engine";
import { FrameType, decodeFrame, encodeFrame } from "@omnisync/protocol";
import { GatewayClient } from "../src/index.js";
import { connectClient, keys, makeWorld, startGateway, until, type Running, type World } from "./harness.js";

describe("client reconnect", () => {
  let world: World;
  const running: Running[] = [];
  const clients: GatewayClient[] = [];

  const start = async (opts: Parameters<typeof startGateway>[1] = {}) => {
    const r = await startGateway(world, opts);
    running.push(r);
    return r;
  };
  const connect = async (r: Running, actor: number, extra: Parameters<typeof connectClient>[3] = {}) => {
    const c = await connectClient(r.url, actor, "yjs", { reconnect: true, ...extra });
    clients.push(c);
    return c;
  };

  beforeEach(async () => {
    world = await makeWorld("memory");
  });

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((c) => c.close()));
    await Promise.allSettled(running.splice(0).map((r) => r.gateway.close()));
    await world.cleanup();
  });

  it("a dropped connection comes back, delivers offline edits and converges with concurrent peers", async () => {
    const r = await start();
    // random() = 0.9 with a 100-200 ms window keeps the offline period long enough to observe.
    const a = await connect(r, 1, { baseMs: 200, maxMs: 200, random: () => 0.9 });
    const b = await connect(r, 2);
    await a.insert(0, "start;");
    await until(() => b.doc.getText() === "start;");

    a.dropConnection();
    expect(a.unacked).toBe(0);
    // Edits made while offline are signed now and queued.
    const offline = [a.insert(a.doc.getText().length, "A1;"), a.insert(a.doc.getText().length, "A2;")];
    await until(() => !a.connected, 1000, "disconnect");
    expect(a.unacked).toBe(2);
    await b.insert(b.doc.getText().length, "B1;");

    await Promise.all(offline);
    await until(() => a.doc.getText() === b.doc.getText() && a.doc.getText().length === "start;A1;A2;B1;".length, 5000, "convergence");
    for (const t of ["start;", "A1;", "A2;", "B1;"]) expect(a.doc.getText()).toContain(t);
    expect(r.gateway.textOf("doc")).toBe(a.doc.getText());
    expect(a.reconnects).toBeGreaterThanOrEqual(1);
  });

  it("survives a gateway crash and restart on the same port without losing queued edits", async () => {
    const r1 = await start();
    const a = await connect(r1, 1, { baseMs: 20, maxMs: 200 });
    await a.insert(0, "committed;");
    await r1.gateway.crash();

    const queued = a.insert(a.doc.getText().length, "typed-while-down;");
    await until(() => !a.connected, 1000, "disconnect");

    const r2 = await start({ port: r1.port });
    await queued;
    const b = await connect(r2, 2);
    expect(b.doc.getText()).toBe("committed;typed-while-down;");
    expect(await world.store.headSeq("doc")).toBe(2);
  });

  it("backs off exponentially with full jitter, capped", async () => {
    const r = await start();
    // random() ~ 1 selects the top of the jitter window, so delays reveal the ceilings.
    const a = await connect(r, 1, { baseMs: 100, maxMs: 1000, random: () => 0.999999 });
    await r.gateway.crash();
    await until(() => a.delays.length >= 6, 8000, "six reconnect attempts");
    const ceilings = [100, 200, 400, 800, 1000, 1000];
    a.delays.slice(0, 6).forEach((d, i) => {
      expect(d).toBeLessThanOrEqual(ceilings[i]!);
      expect(d).toBeGreaterThanOrEqual(ceilings[i]! - 2);
    });
  }, 15_000);

  it("jitter spreads delays across the whole window", async () => {
    const r = await start();
    const a = await connect(r, 1, { baseMs: 1000, maxMs: 1000, random: () => 0.25 });
    await r.gateway.crash();
    await until(() => a.delays.length >= 1, 3000, "first attempt");
    expect(a.delays[0]).toBe(250);
  });

  it("honours a server `busy` hint by asking again later", async () => {
    let hellos = 0;
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((r) => wss.once("listening", r));
    wss.on("connection", (ws) => {
      ws.on("message", (d: Buffer) => {
        const f = decodeFrame(new Uint8Array(d));
        if (f.type !== FrameType.SYNC_1) return;
        if (hellos++ === 0) {
          ws.send(encodeFrame({ type: FrameType.ERROR, flags: 0, sessionId: 0, seq: 0, payload: new TextEncoder().encode("busy;retry_after_ms=120") }));
        } else {
          ws.send(encodeFrame({ type: FrameType.SYNC_2, flags: 0, sessionId: 0, seq: 0, payload: engines.yjs.create(9).encodeDiff(f.payload) }));
        }
      });
    });
    const port = (wss.address() as { port: number }).port;
    const t0 = Date.now();
    const c = await GatewayClient.connect({ url: `ws://127.0.0.1:${port}`, docId: "doc", actor: 1, key: keys[1]!, reconnect: false });
    clients.push(c);
    expect(hellos).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
    await c.close();
    await new Promise((r) => wss.close(r));
  });

  it("a gateway that never answers the handshake is treated as dead", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((r) => wss.once("listening", r));
    let connections = 0;
    wss.on("connection", () => connections++); // accepts, never replies
    const port = (wss.address() as { port: number }).port;
    const p = GatewayClient.connect({
      url: `ws://127.0.0.1:${port}`,
      docId: "doc",
      actor: 1,
      key: keys[1]!,
      syncTimeoutMs: 100,
      backoff: { baseMs: 10, maxMs: 20 },
    });
    p.catch(() => {});
    await until(() => connections >= 3, 4000, "repeated attempts after handshake timeouts");
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => wss.close(r));
  });

  it("reconnect storm: all clients return after a gateway restart and keep converging", async () => {
    const N = Number(process.env.STORM_CLIENTS ?? 60);
    const r1 = await start({ maxConcurrentCatchUps: 4 });
    const swarm = await Promise.all(
      Array.from({ length: N }, (_, i) => connect(r1, i + 1, { baseMs: 20, maxMs: 400 })),
    );
    await swarm[0]!.insert(0, "seed;");
    await until(() => swarm.every((c) => c.doc.getText() === "seed;"), 10_000, "initial fan-out");

    await r1.gateway.crash();
    await until(() => swarm.every((c) => !c.connected), 3000, "all disconnected");
    // Edits typed during the outage by a few clients.
    const offline = [1, 2, 3].map((i) => swarm[i]!.insert(swarm[i]!.doc.getText().length, `off${i};`));

    const t0 = Date.now();
    const r2 = await start({ port: r1.port, maxConcurrentCatchUps: 4 });
    await until(() => swarm.every((c) => c.connected), 20_000, "all clients reconnected");
    const reconnectMs = Date.now() - t0;
    await Promise.all(offline);

    await swarm[N - 1]!.insert(swarm[N - 1]!.doc.getText().length, "after;");
    await until(() => swarm.every((c) => c.doc.getText() === r2.gateway.textOf("doc")), 20_000, "everyone converged");
    const text = r2.gateway.textOf("doc")!;
    for (const t of ["seed;", "off1;", "off2;", "off3;", "after;"]) expect(text).toContain(t);
    expect(reconnectMs).toBeLessThan(20_000);
    expect(r2.gateway.stats.connections).toBe(N);
  }, 60_000);
});
