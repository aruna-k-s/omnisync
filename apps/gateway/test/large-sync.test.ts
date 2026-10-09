import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { FrameType, MAX_INBOUND_PAYLOAD_BYTES, encodeFrame } from "@omnisync/protocol";
import { GatewayClient } from "../src/index.js";
import { connectClient, keys, makeWorld, startGateway, type Running, type World } from "./harness.js";

/** Ticket L1 (docs/specs/large-sync.md): a client must be able to open a document whose state is over 1 MiB. */
describe("opening a large document", () => {
  let world: World;
  let r: Running;
  const clients: GatewayClient[] = [];
  const CHUNK = 32 * 1024;
  const CHUNKS = 100; // 3.2 MB of text, far over the 1 MiB default decode cap
  const expectedLength = CHUNK * CHUNKS;

  beforeEach(async () => {
    world = await makeWorld("memory");
    r = await startGateway(world);
    const writer = await connectClient(r.url, 1);
    clients.push(writer);
    for (let i = 0; i < CHUNKS; i++) await writer.insert(writer.doc.getText().length, String.fromCharCode(97 + (i % 26)).repeat(CHUNK));
    expect(r.gateway.textOf("doc")?.length).toBe(expectedLength);
  }, 60_000);

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((c) => c.close()));
    await r.gateway.close();
    await world.cleanup();
  });

  it("a stock client syncs it, and the text is the writer's", async () => {
    const reader = await connectClient(r.url, 2);
    clients.push(reader);
    expect(reader.doc.getText().length).toBe(expectedLength);
    expect(reader.doc.getText()).toBe(r.gateway.textOf("doc"));
    expect(reader.decodeErrors).toBe(0);
  }, 30_000);

  it("a client with a smaller maxInboundBytes does not sync, and says why instead of staying silent", async () => {
    let failure: Error | undefined;
    await GatewayClient.connect({ url: r.url, docId: "doc", actor: 3, key: keys[3]!, reconnect: false, syncTimeoutMs: 1500, maxInboundBytes: 512 * 1024 }).then(
      (c) => clients.push(c),
      (e: Error) => {
        failure = e;
      },
    );
    expect(failure?.message).toMatch(/connection closed before sync: dropped frame \(1 dropped, last: [^)]*too_large/);
  }, 30_000);

  it("rejects a nonsensical maxInboundBytes", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, MAX_INBOUND_PAYLOAD_BYTES * 2]) {
      await expect(GatewayClient.connect({ url: r.url, docId: "doc", actor: 4, key: keys[4]!, reconnect: false, maxInboundBytes: bad })).rejects.toThrow(/maxInboundBytes/);
    }
  });
});

describe("frames the client cannot decode", () => {
  async function garbageServer(frames: Uint8Array[]) {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((res) => wss.on("listening", () => res()));
    wss.on("connection", (ws) => frames.forEach((f) => ws.send(f)));
    return { url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`, close: () => new Promise<void>((res) => wss.close(() => res())) };
  }

  it("are dropped without throwing, reported to onDecodeError, and named in the failure when the handshake ends", async () => {
    const server = await garbageServer([new Uint8Array([1, 2, 3]), new Uint8Array([9, 9, 9, 9])]);
    const seen: string[] = [];
    const failure = await GatewayClient.connect({
      url: server.url,
      docId: "doc",
      actor: 5,
      key: keys[5]!,
      reconnect: false,
      syncTimeoutMs: 300,
      onDecodeError: (e) => seen.push(e),
    }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(seen).toHaveLength(2);
    expect(seen.every((e) => e.length > 0)).toBe(true);
    expect(failure?.message).toMatch(/connection closed before sync: dropped frame \(2 dropped, last: /);
    await server.close();
  });

  it("a callback that throws does not break the connection", async () => {
    const server = await garbageServer([new Uint8Array([1, 2, 3])]);
    const failure = await GatewayClient.connect({
      url: server.url,
      docId: "doc",
      actor: 5,
      key: keys[5]!,
      reconnect: false,
      syncTimeoutMs: 300,
      onDecodeError: () => {
        throw new Error("observer bug");
      },
    }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(failure?.message).toMatch(/dropped frame \(1 dropped/);
    await server.close();
  });

  it("a reason the gateway itself gave wins over the note about dropped frames", async () => {
    const reason = encodeFrame({ type: FrameType.ERROR, flags: 0, sessionId: 0, seq: 0, payload: new TextEncoder().encode("forbidden") });
    const server = await garbageServer([new Uint8Array([1, 2, 3]), reason]);
    const failure = await GatewayClient.connect({ url: server.url, docId: "doc", actor: 5, key: keys[5]!, reconnect: false, syncTimeoutMs: 300 }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(failure?.message).toBe("connection closed before sync: forbidden");
    await server.close();
  });
});
