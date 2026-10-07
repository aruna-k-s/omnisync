import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import fc from "fast-check";
import { yjsEngine } from "@omnisync/engine/yjs";
import { FrameType, decodeFrame, encodeFrame, type Frame } from "@omnisync/protocol";
import { backoffDelay } from "../src/backoff.js";
import { OmniSyncClient } from "../src/client.js";
import { createDeviceKey, type DeviceKey } from "../src/keys.js";
import { MemoryOutbox } from "../src/outbox.js";
import { World, craftFrame, sleep, until } from "./harness.js";

/** A gateway double that speaks the handshake and lets each test script the rest. */
class Script {
  readonly wss: WebSocketServer;
  readonly sockets: ServerSocket[] = [];
  readonly received: { at: number; frame: Frame }[] = [];
  connections = 0;
  onConnect: (ws: ServerSocket, n: number) => void = () => {};
  onFrame: (ws: ServerSocket, f: Frame, n: number) => void = () => {};
  /** [role index, mode] sent as AUTH_RESULT. */
  authResult: [number, number] = [1, 0];
  challenge = true;

  private constructor(wss: WebSocketServer) {
    this.wss = wss;
    wss.on("connection", (ws) => {
      const n = ++this.connections;
      this.sockets.push(ws);
      this.onConnect(ws, n);
      if (this.challenge) ws.send(encodeFrame({ type: FrameType.AUTH_CHALLENGE, flags: 0, sessionId: 0, seq: 0, claimedAtMs: Date.now(), payload: new Uint8Array(32).fill(7) }));
      ws.on("message", (d: Buffer) => {
        const f = decodeFrame(new Uint8Array(d));
        this.received.push({ at: Date.now(), frame: f });
        if (f.type === FrameType.AUTH_RESPONSE) ws.send(encodeFrame({ type: FrameType.AUTH_RESULT, flags: 0, sessionId: 0, seq: 0, payload: Uint8Array.of(...this.authResult) }));
        else this.onFrame(ws, f, n);
      });
      ws.on("error", () => {});
    });
  }
  static async start(): Promise<Script> {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.once("listening", () => r()));
    return new Script(wss);
  }
  get url(): string {
    return `ws://127.0.0.1:${(this.wss.address() as { port: number }).port}`;
  }
  count(type: number): number {
    return this.received.filter((r) => r.frame.type === type).length;
  }
  send(ws: ServerSocket, type: number, extra: { payload?: Uint8Array; seq?: number; sessionId?: number } = {}): void {
    ws.send(encodeFrame({ type: type as 1, flags: 0, sessionId: extra.sessionId ?? 0, seq: extra.seq ?? 0, payload: extra.payload ?? (type === FrameType.SYNC_2 ? EMPTY : new Uint8Array()) }));
  }
  err(ws: ServerSocket, reason: string, seq = 0): void {
    this.send(ws, FrameType.ERROR, { payload: new TextEncoder().encode(reason), seq });
  }
  async stop(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}

const EMPTY = (() => {
  const d = yjsEngine.create(1);
  const snap = d.snapshot();
  d.destroy();
  return snap;
})();

const remoteText = (text: string, actor = 4242) => {
  const d = yjsEngine.create(actor);
  const u = d.insertText(0, text);
  d.destroy();
  return u;
};

describe("connection behaviour against a scripted gateway", () => {
  const scripts: Script[] = [];
  const clients: OmniSyncClient[] = [];
  let world: World;
  let key: DeviceKey;
  let certificate: Uint8Array;

  const setup = async () => {
    world = new World();
    key = await createDeviceKey();
    ({ certificate } = await world.enroll(await world.person("sam"), key, { doc: "write" }));
    const s = await Script.start();
    scripts.push(s);
    return s;
  };
  const open = async (s: Script, tuning: Record<string, unknown> = {}, outbox = new MemoryOutbox()) => {
    const c = new OmniSyncClient({
      url: s.url,
      key,
      certificate,
      outbox: () => outbox,
      tuning: { batch: { minMs: 2, maxMs: 10 }, backoff: { baseMs: 20, maxMs: 100 }, syncTimeoutMs: 1000, ...tuning },
    });
    clients.push(c);
    return { doc: await c.open("doc"), outbox };
  };

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((c) => c.close()));
    await Promise.allSettled(scripts.splice(0).map((s) => s.stop()));
  });

  it("answers the gateway's challenge with the certificate and a proof made by the non-extractable key", async () => {
    const s = await setup();
    s.onFrame = (ws, f) => f.type === FrameType.SYNC_1 && s.send(ws, FrameType.SYNC_2, { payload: remoteText("hi") });
    const { doc } = await open(s);
    await doc.online();
    expect(key.extractable).toBe(false);
    expect(doc.text).toBe("hi");
    expect(s.count(FrameType.AUTH_RESPONSE)).toBe(1);
    expect(doc.role).toBe("write");
  });

  it("honours busy;retry_after_ms by asking again on the same socket no sooner than told", async () => {
    const s = await setup();
    let sync1 = 0;
    s.onFrame = (ws, f) => {
      if (f.type !== FrameType.SYNC_1) return;
      if (++sync1 === 1) s.err(ws, "busy;retry_after_ms=300");
      else s.send(ws, FrameType.SYNC_2, { payload: remoteText("later") });
    };
    const { doc } = await open(s);
    await doc.online();
    const times = s.received.filter((r) => r.frame.type === FrameType.SYNC_1).map((r) => r.at);
    expect(times).toHaveLength(2);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(290);
    expect(s.connections).toBe(1);
    expect(doc.text).toBe("later");
  });

  it("never applies an update that arrives before the handshake finished, or at all in upload-only mode", async () => {
    const s = await setup();
    const other = await createDeviceKey();
    const early = (await craftFrame(other, "doc", 9, 1, Date.now(), "early")).bytes;
    const nor = (await craftFrame(other, "doc", 9, 2, Date.now(), "nor this")).bytes;
    s.onConnect = (ws) => {
      ws.send(early);
      s.send(ws, FrameType.SYNC_2, { payload: remoteText("sneaky", 5151) }); // a SYNC_2 nobody asked for, before the handshake
    };
    s.onFrame = (ws, f) => f.type === FrameType.SYNC_1 && s.send(ws, FrameType.SYNC_2, { payload: remoteText("ok") });
    const { doc } = await open(s);
    await doc.online();
    expect(doc.text).toBe("ok");
    expect(doc.text).not.toContain("early");
    expect(doc.text).not.toContain("sneaky");

    // Upload-only: the gateway says "mode 1": the SDK drains its outbox and reads nothing.
    s.authResult = [1, 1];
    const s2 = await Script.start();
    scripts.push(s2);
    s2.authResult = [1, 1];
    s2.onFrame = (ws, f) => {
      if (f.type === FrameType.SYNC_2 || f.type === FrameType.SYNC_1) s2.send(ws, FrameType.SYNC_2, { payload: remoteText("must not read") });
      if (f.type === FrameType.UPDATE) s2.send(ws, FrameType.ACK, { sessionId: f.sessionId, seq: f.seq });
    };
    s2.onConnect = (ws) => ws.send(nor);
    const ob = new MemoryOutbox();
    await ob.append([await craftFrame(key, "doc", 5, 1, Date.now())]);
    const { doc: up } = await open(s2, {}, ob);
    await up.synced();
    expect(up.status).toMatchObject({ state: "online", mode: "upload_only" });
    expect(up.text).toBe("x"); // only its own pending edit, rebuilt locally
    expect(s2.count(FrameType.SYNC_1)).toBe(0);
  });

  it("keeps a frame queued on a retryable error and resends it", async () => {
    const s = await setup();
    let tries = 0;
    s.onFrame = (ws, f) => {
      if (f.type === FrameType.SYNC_1) s.send(ws, FrameType.SYNC_2);
      if (f.type === FrameType.UPDATE) {
        if (++tries === 1) s.err(ws, "unavailable", f.seq);
        else s.send(ws, FrameType.ACK, { sessionId: f.sessionId, seq: f.seq });
      }
    };
    const { doc, outbox } = await open(s);
    await doc.online();
    doc.insertText(0, "x");
    await doc.synced();
    expect(tries).toBe(2);
    expect(await outbox.pending()).toEqual([]);
    expect(doc.refusedEdits).toBe(0);
  });

  it("an edit the gateway refuses for good is dropped so the ones behind it still go", async () => {
    const s = await setup();
    s.onFrame = (ws, f) => {
      if (f.type === FrameType.SYNC_1) s.send(ws, FrameType.SYNC_2);
      if (f.type === FrameType.UPDATE) {
        if (f.seq === 1) s.err(ws, "claimed_in_future", f.seq);
        else s.send(ws, FrameType.ACK, { sessionId: f.sessionId, seq: f.seq });
      }
    };
    const { doc } = await open(s);
    await doc.online();
    doc.insertText(0, "a");
    await sleep(30);
    doc.insertText(1, "b");
    await doc.synced();
    expect(doc.refusedEdits).toBe(1);
    expect(doc.pending).toBe(0);
  });

  it("stops retrying on a permanent close code, and keeps retrying on an ordinary drop", async () => {
    const s = await setup();
    s.onFrame = (ws, f) => f.type === FrameType.SYNC_1 && s.send(ws, FrameType.SYNC_2);
    s.onConnect = () => {};
    const { doc } = await open(s);
    await doc.online();
    s.sockets[0]!.close(1001, "going away");
    await until(() => s.connections >= 2, 3000, "reconnect after an ordinary close");
    await doc.online();
    s.sockets.at(-1)!.close(4403, "no_access");
    await until(() => doc.status.state === "closed", 3000, "closed");
    expect(doc.status.reason).toBe("no_access");
    const n = s.connections;
    await sleep(300);
    expect(s.connections).toBe(n);
  });

  it("sends one session's frames at a time, each exactly once, and the next session only after the first is acknowledged", async () => {
    const s = await setup();
    const ob = new MemoryOutbox();
    await ob.append([await craftFrame(key, "doc", 11, 1, Date.now(), "a"), await craftFrame(key, "doc", 11, 2, Date.now(), "b")]);
    await ob.append([await craftFrame(key, "doc", 22, 1, Date.now(), "c")]);
    const seen: string[] = [];
    const sockets: { ws: ServerSocket; f: Frame }[] = [];
    s.onFrame = (ws, f) => {
      if (f.type === FrameType.SYNC_1) s.send(ws, FrameType.SYNC_2);
      if (f.type === FrameType.UPDATE) {
        seen.push(`${f.sessionId}:${f.seq}`);
        sockets.push({ ws, f });
      }
    };
    const { doc } = await open(s, {}, ob);
    await until(() => seen.length >= 2, 3000, "first session sent");
    const ack = (id: string) => {
      const x = sockets.find((q) => `${q.f.sessionId}:${q.f.seq}` === id)!;
      s.send(x.ws, FrameType.ACK, { sessionId: x.f.sessionId, seq: x.f.seq });
    };
    ack("11:1"); // a reason for the client to look at its queue again
    await sleep(150);
    expect(seen).toEqual(["11:1", "11:2"]); // no duplicates, and nothing from session 22 yet
    ack("11:2");
    await until(() => seen.includes("22:1"), 3000, "second session sent");
    expect(seen).toEqual(["11:1", "11:2", "22:1"]);
    ack("22:1");
    await doc.synced();
  });

  it("synced() resolves only when every edit is acknowledged, and a repeated ACK clears nothing else", async () => {
    const s = await setup();
    const ob = new MemoryOutbox();
    await ob.append([await craftFrame(key, "doc", 11, 1, Date.now(), "a"), await craftFrame(key, "doc", 11, 2, Date.now(), "b")]);
    const held: { ws: ServerSocket; f: Frame }[] = [];
    s.onFrame = (ws, f) => {
      if (f.type === FrameType.SYNC_1) s.send(ws, FrameType.SYNC_2);
      if (f.type === FrameType.UPDATE) held.push({ ws, f });
    };
    const { doc } = await open(s, {}, ob);
    let done = false;
    const waiting = doc.synced().then(() => (done = true));
    await until(() => held.length === 2, 3000, "both sent");
    const [one, two] = held as [(typeof held)[0], (typeof held)[0]];
    s.send(one.ws, FrameType.ACK, { sessionId: 11, seq: 1 });
    s.send(one.ws, FrameType.ACK, { sessionId: 11, seq: 1 }); // the same ACK again
    await sleep(150);
    expect(done).toBe(false);
    expect(doc.pending).toBe(1);
    expect((await ob.pending()).map((f) => f.seq)).toEqual([2]);
    s.send(two.ws, FrameType.ACK, { sessionId: 11, seq: 2 });
    await waiting;
    expect(doc.pending).toBe(0);
  });

  it("a replay answer means the frame is already stored: delivered, not refused", async () => {
    const s = await setup();
    s.onFrame = (ws, f) => {
      if (f.type === FrameType.SYNC_1) s.send(ws, FrameType.SYNC_2);
      if (f.type === FrameType.UPDATE) s.err(ws, "replay", f.seq);
    };
    const { doc } = await open(s);
    await doc.online();
    doc.insertText(0, "x");
    await doc.synced();
    expect(doc.pending).toBe(0);
    expect(doc.refusedEdits).toBe(0);
  });

  it("close code 4401 is permanent; with a transient reason it is retried", async () => {
    const s = await setup();
    s.onFrame = (ws, f) => f.type === FrameType.SYNC_1 && s.send(ws, FrameType.SYNC_2);
    const { doc } = await open(s);
    await doc.online();
    s.sockets[0]!.close(4401, "timeout");
    await until(() => s.connections >= 2, 3000, "retry after a transient 4401");
    expect(doc.status.state).not.toBe("closed");
    await doc.online();
    s.sockets.at(-1)!.close(4401, "expired");
    await until(() => doc.status.state === "closed", 3000, "closed");
    expect(doc.status.reason).toBe("expired");
  });

  it("a busy answer raises the wait before the next reconnect", async () => {
    const s = await setup();
    s.onFrame = (ws, f) => {
      if (f.type !== FrameType.SYNC_1) return;
      s.err(ws, "busy;retry_after_ms=400");
      setTimeout(() => ws.close(1001, "bye"), 10);
    };
    const { doc } = await open(s, { random: () => 0 });
    await until(() => doc.delays.length >= 1, 3000, "a reconnect was scheduled");
    expect(doc.delays[0]).toBeGreaterThanOrEqual(400);
  });

  it("a renewed certificate replaces the connection and is used for the handshake", async () => {
    const s = await setup();
    s.onFrame = (ws, f) => f.type === FrameType.SYNC_1 && s.send(ws, FrameType.SYNC_2);
    const c = new OmniSyncClient({ url: s.url, key, certificate, outbox: () => new MemoryOutbox(), tuning: { batch: { minMs: 2, maxMs: 10 }, backoff: { baseMs: 20, maxMs: 100 }, syncTimeoutMs: 1000 } });
    clients.push(c);
    const doc = await c.open("doc");
    await doc.online();
    const { certificate: fresh } = await world.enroll(await world.person("sam2"), key, { doc: "write" });
    c.setCertificate(fresh);
    await until(() => s.connections === 2 && doc.status.state === "online", 3000, "second connection");
    expect(s.count(FrameType.AUTH_RESPONSE)).toBe(2);
    const last = s.received.filter((r) => r.frame.type === FrameType.AUTH_RESPONSE).at(-1)!.frame.payload;
    expect(Buffer.from(last).includes(Buffer.from(fresh))).toBe(true);
  });

  it("a retryable handshake refusal keeps trying", async () => {
    const s = await setup();
    s.authResult = [1, 0];
    s.onConnect = () => {};
    let n = 0;
    s.onFrame = (ws, f) => f.type === FrameType.SYNC_1 && s.send(ws, FrameType.SYNC_2);
    s.wss.removeAllListeners("connection");
    s.wss.on("connection", (ws) => {
      n++;
      s.sockets.push(ws);
      ws.send(encodeFrame({ type: FrameType.AUTH_CHALLENGE, flags: 0, sessionId: 0, seq: 0, claimedAtMs: Date.now(), payload: new Uint8Array(32) }));
      ws.on("message", (d: Buffer) => {
        const f = decodeFrame(new Uint8Array(d));
        if (f.type === FrameType.AUTH_RESPONSE) {
          if (n === 1) {
            s.err(ws, "auth_failed;unavailable");
            ws.close(1013, "unavailable");
          } else ws.send(encodeFrame({ type: FrameType.AUTH_RESULT, flags: 0, sessionId: 0, seq: 0, payload: Uint8Array.of(1, 0) }));
        } else s.onFrame(ws, f, n);
      });
      ws.on("error", () => {});
    });
    const { doc } = await open(s);
    await doc.online();
    expect(n).toBe(2);
  });

  it("a connection that never answers is abandoned and retried", async () => {
    const s = await setup();
    let n = 0;
    s.wss.removeAllListeners("connection");
    s.wss.on("connection", (ws) => {
      n++;
      s.sockets.push(ws);
      ws.on("error", () => {});
      if (n >= 2) {
        ws.send(encodeFrame({ type: FrameType.AUTH_CHALLENGE, flags: 0, sessionId: 0, seq: 0, claimedAtMs: Date.now(), payload: new Uint8Array(32) }));
        ws.on("message", (d: Buffer) => {
          const f = decodeFrame(new Uint8Array(d));
          if (f.type === FrameType.AUTH_RESPONSE) ws.send(encodeFrame({ type: FrameType.AUTH_RESULT, flags: 0, sessionId: 0, seq: 0, payload: Uint8Array.of(1, 0) }));
          if (f.type === FrameType.SYNC_1) s.send(ws, FrameType.SYNC_2);
        });
      }
    });
    const { doc } = await open(s, { syncTimeoutMs: 150 });
    await doc.online();
    expect(n).toBeGreaterThanOrEqual(2);
    expect(doc.errors.some((e) => e.includes("timed out"))).toBe(true);
  });

  it("the backoff starts over only after a connection has stayed up", async () => {
    // Drops right after coming online: delays keep growing.
    const s = await setup();
    s.onFrame = (ws, f) => {
      if (f.type === FrameType.SYNC_1) {
        s.send(ws, FrameType.SYNC_2);
        setTimeout(() => ws.close(1001, "bye"), 20);
      }
    };
    const { doc } = await open(s, { random: () => 0.999999, backoff: { baseMs: 20, maxMs: 1000, stableMs: 10_000 } });
    await until(() => doc.delays.length >= 4, 5000, "four reconnects");
    expect(doc.delays.slice(0, 4)).toEqual([20, 40, 80, 160]);

    // Stays up past the stable window: the next failure starts from the base again.
    const t = await Script.start();
    scripts.push(t);
    let conns = 0;
    t.onFrame = (ws, f) => {
      if (f.type !== FrameType.SYNC_1) return;
      t.send(ws, FrameType.SYNC_2);
      if (++conns <= 2) setTimeout(() => ws.close(1001, "bye"), 120);
    };
    const { doc: d2 } = await open(t, { random: () => 0.999999, backoff: { baseMs: 20, maxMs: 1000, stableMs: 40 } });
    await until(() => d2.delays.length >= 2, 5000, "two reconnects");
    expect(d2.delays.slice(0, 2)).toEqual([20, 20]);
  });
});

describe("backoff", () => {
  it("full jitter: within [floor, ceiling], ceiling doubles then caps, the floor wins", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40 }), fc.integer({ min: 1, max: 500 }), fc.integer({ min: 500, max: 60_000 }), fc.double({ min: 0, max: 1, noNaN: true }), fc.integer({ min: 0, max: 5000 }), (attempt, baseMs, maxMs, r, floorMs) => {
        const d = backoffDelay({ attempt, baseMs, maxMs, random: () => Math.min(r, 0.9999999), floorMs });
        const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 20));
        expect(d).toBeGreaterThanOrEqual(floorMs);
        expect(d).toBeLessThanOrEqual(Math.max(ceiling, floorMs));
        expect(Number.isInteger(d)).toBe(true);
      }),
    );
  });
  it("is deterministic given the random source", () => {
    expect(backoffDelay({ attempt: 3, baseMs: 100, maxMs: 10_000, random: () => 0 })).toBe(0);
    expect(backoffDelay({ attempt: 3, baseMs: 100, maxMs: 10_000, random: () => 0.999999999 })).toBe(800);
    expect(backoffDelay({ attempt: 30, baseMs: 100, maxMs: 5000, random: () => 0.999999999 })).toBe(5000);
  });
});
