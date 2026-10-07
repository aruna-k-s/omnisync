// @vitest-environment jsdom
import { act, createElement, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket as NodeWebSocket, WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { yjsEngine } from "@omnisync/engine/yjs";
import { FrameType, decodeFrame, encodeFrame, generateKeyPair, signDetached, signUpdate } from "@omnisync/protocol";
import { MemoryOutbox, OmniSyncClient, type DeviceKey } from "@omnisync/sdk";
import { OmniSyncProvider, useDocument, usePending, useStatus, type UseDocument } from "../src/index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pair = generateKeyPair(new Uint8Array(32).fill(9));
const key: DeviceKey = { keyId: pair.keyId, publicKey: pair.publicKey, extractable: true, sign: (m) => Promise.resolve(signDetached(m, pair.secretKey)) };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await act(async () => {
      await sleep(10);
    });
  }
};

/** Answers SYNC_1 with a document that already says "base", ACKs every UPDATE, and can push a remote edit. */
async function gatewayDouble() {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const sockets: ServerSocket[] = [];
  let connections = 0;
  const base = yjsEngine.create(77);
  base.insertText(0, "base");
  const baseState = base.snapshot();
  wss.on("connection", (ws) => {
    connections++;
    sockets.push(ws);
    ws.on("error", () => {});
    ws.on("message", (d: Buffer) => {
      const f = decodeFrame(new Uint8Array(d));
      if (f.type === FrameType.SYNC_1) ws.send(encodeFrame({ type: FrameType.SYNC_2, flags: 0, sessionId: 0, seq: 0, payload: baseState }));
      if (f.type === FrameType.UPDATE) ws.send(encodeFrame({ type: FrameType.ACK, flags: 0, sessionId: f.sessionId, seq: f.seq, payload: new Uint8Array() }));
    });
  });
  const other = generateKeyPair(new Uint8Array(32).fill(3));
  return {
    url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`,
    get connections() {
      return connections;
    },
    pushRemote(text: string) {
      const peer = yjsEngine.create(78);
      peer.applyUpdate(baseState);
      const update = peer.insertText(4, text);
      const bytes = signUpdate({ docId: "doc", sessionId: 1, seq: 1, claimedAtMs: Date.now(), payload: update }, other);
      for (const s of sockets) s.send(bytes);
    },
    stop: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.terminate();
        wss.close(() => r());
      }),
  };
}

describe("React hooks", () => {
  let gw: Awaited<ReturnType<typeof gatewayDouble>>;
  let client: OmniSyncClient;
  let root: Root | undefined;
  let container: HTMLElement;

  beforeEach(async () => {
    gw = await gatewayDouble();
    client = new OmniSyncClient({
      url: gw.url,
      key,
      outbox: () => new MemoryOutbox(),
      tuning: { WebSocket: NodeWebSocket as unknown as typeof WebSocket, batch: { minMs: 2, maxMs: 10 }, backoff: { baseMs: 10, maxMs: 50 }, syncTimeoutMs: 1000 },
    });
    container = document.createElement("div");
    document.body.append(container);
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    await client.close();
    await gw.stop();
    container.remove();
  });

  const render = async (node: ReactNode) => {
    root = createRoot(container);
    await act(async () => root!.render(node));
  };

  it("shows the document as it loads, re-renders on local edits, remote edits and confirmations", async () => {
    let latest: UseDocument | undefined;
    const renders: number[] = [];
    function View() {
      const d = useDocument("doc");
      latest = d;
      renders.push(1);
      return createElement("p", { "data-testid": "text" }, `${d.text}|${d.status.state}|${d.pending}`);
    }
    await render(createElement(OmniSyncProvider, { client }, createElement(View)));
    expect(container.textContent).not.toContain("base"); // before the document has synced: an empty view, not a crash
    await until(() => container.textContent === "base|online|0");

    await act(async () => latest!.doc!.insertText(4, "+me"));
    expect(container.textContent).toBe("base+me|online|1"); // applied and counted at once
    await until(() => container.textContent === "base+me|online|0"); // confirmed

    await act(async () => gw.pushRemote("+them"));
    await until(() => container.textContent!.includes("+them"));

    // Nothing changing means nothing re-rendering.
    const n = renders.length;
    await act(async () => {
      await sleep(80);
    });
    expect(renders.length).toBe(n);
  });

  it("structured data is part of the view", async () => {
    let latest: UseDocument | undefined;
    function View() {
      latest = useDocument(client, "doc");
      return createElement("p", null, JSON.stringify(latest.data));
    }
    await render(createElement(View));
    await until(() => latest?.status.state === "online");
    await act(async () => latest!.doc!.mapSet([], "title", "Q3"));
    expect(container.textContent).toBe('{"title":"Q3"}');
  });

  it("useStatus and usePending follow the connection and the queue", async () => {
    let doc: UseDocument | undefined;
    function Banner() {
      const s = useStatus("doc");
      const p = usePending("doc");
      return createElement("b", null, `${s.state}/${p}`);
    }
    function Holder() {
      doc = useDocument("doc");
      return createElement(Banner);
    }
    await render(createElement(OmniSyncProvider, { client }, createElement(Holder)));
    await until(() => container.textContent === "online/0");
    await act(async () => doc!.doc!.disconnect());
    expect(container.textContent).toBe("offline/0");
    await act(async () => doc!.doc!.insertText(0, "x"));
    expect(container.textContent).toBe("offline/1");
    await act(async () => doc!.doc!.connect());
    await until(() => container.textContent === "online/0");
  });

  it("components share one open document; it closes after the last one goes, and a quick remount does not reconnect", async () => {
    function A() {
      return createElement("i", null, useDocument(client, "doc").text);
    }
    await render(createElement("div", null, createElement(A), createElement(A)));
    await until(() => container.textContent === "basebase");
    expect(gw.connections).toBe(1);

    await act(async () => root!.render(createElement("div")));
    await act(async () => root!.render(createElement(A))); // remounted inside the grace period
    await until(() => container.textContent === "base");
    expect(gw.connections).toBe(1);

    await act(async () => root!.render(createElement("div")));
    await act(async () => {
      await sleep(1200);
    });
    await act(async () => root!.render(createElement(A))); // after it closed: a fresh open
    await until(() => container.textContent === "base");
    expect(gw.connections).toBe(2);
  });

  it("reports a document that cannot be opened, and explains a missing provider", async () => {
    const broken = new OmniSyncClient({ url: gw.url, key, outbox: () => Promise.reject(new Error("storage blocked")) });
    let seen: UseDocument | undefined;
    function V() {
      seen = useDocument(broken, "doc");
      return createElement("p", null, seen.error?.message ?? "ok");
    }
    await render(createElement(V));
    await until(() => container.textContent === "storage blocked");
    expect(seen!.doc).toBeUndefined();

    await act(async () => root!.unmount());
    root = createRoot(container);
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = () => {};
    function NoProvider() {
      try {
        useDocument("doc");
      } catch (e) {
        errors.push(e);
      }
      return null;
    }
    await act(async () => root!.render(createElement(NoProvider)));
    console.error = orig;
    expect(String((errors[0] as Error).message)).toMatch(/OmniSyncProvider/);
    void useRef;
  });
});
