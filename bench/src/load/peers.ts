import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import { getEngine, type EngineDoc, type EngineName } from "@omnisync/engine";
import { FrameType, decodeFrame, encodeFrame, signUpdate, type KeyPair } from "@omnisync/protocol";

/**
 * A connection that does what a gateway needs from a client and nothing else: the SYNC_1/SYNC_2 handshake, then
 * (optionally) signed edits. It does not apply what it receives. The scenarios use it for the many readers and typists,
 * where applying every relayed edit 100 times over in one Node thread would measure the generator; a few real
 * `GatewayClient`s apply everything and are the probes (spec: docs/specs/load.md).
 */
export class RawPeer {
  received = 0;
  acks = 0;
  /** Send-to-ACK time of each edit, with the time on the generator's clock when the ACK arrived. */
  readonly ackSamples: { at: number; ms: number }[] = [];
  readonly #ws: WebSocket;
  readonly #doc: EngineDoc;
  readonly #sessionId = Math.floor(Math.random() * 2 ** 31);
  readonly #sent = new Map<number, number>();
  readonly #opts: { docId: string; key: KeyPair };
  #seq = 0;
  #len = 0;
  #synced = false;

  private constructor(ws: WebSocket, doc: EngineDoc, opts: { docId: string; key: KeyPair }) {
    this.#ws = ws;
    this.#doc = doc;
    this.#opts = opts;
  }

  static async connect(opts: { url: string; docId: string; key: KeyPair; actor: number; engine: EngineName }): Promise<RawPeer> {
    const doc = getEngine(opts.engine).create(opts.actor);
    const ws = new WebSocket(`${opts.url}/doc/${encodeURIComponent(opts.docId)}`);
    const peer = new RawPeer(ws, doc, { docId: opts.docId, key: opts.key });
    await new Promise<void>((resolve, reject) => {
      ws.once("error", reject);
      ws.on("message", (data: Buffer) => {
        peer.received++;
        if (peer.#synced) {
          if (peer.#wantsAcks) peer.#onFrame(new Uint8Array(data));
          return;
        }
        const frame = decodeFrame(new Uint8Array(data));
        if (frame.type === FrameType.SYNC_2) {
          peer.#synced = true;
          resolve();
        }
      });
      ws.once("open", () => {
        ws.send(encodeFrame({ type: FrameType.SYNC_1, flags: 0, sessionId: peer.#sessionId, seq: 0, payload: doc.encodeStateVector() }));
      });
      ws.once("close", () => reject(new Error("closed before sync")));
    });
    ws.on("error", () => {});
    return peer;
  }

  #wantsAcks = false;

  /** Starts counting ACKs and their latency. Only typists need it. */
  trackAcks(): void {
    this.#wantsAcks = true;
  }

  #onFrame(bytes: Uint8Array): void {
    let frame;
    try {
      frame = decodeFrame(bytes);
    } catch {
      return;
    }
    if (frame.type !== FrameType.ACK) return;
    const t0 = this.#sent.get(frame.seq);
    if (t0 !== undefined) {
      this.#sent.delete(frame.seq);
      this.acks++;
      const now = performance.now();
      this.ackSamples.push({ at: now, ms: now - t0 });
    }
  }

  /** Makes one local edit (an append) and sends it signed. Returns the engine update, the key probes correlate on, and the time before the edit was made. */
  type(char: string, clock = Date.now): { update: Uint8Array; t0: number } {
    const t0 = performance.now();
    const update = this.#doc.insertText(this.#len, char);
    this.#len += char.length;
    const seq = ++this.#seq;
    const bytes = signUpdate({ docId: this.#opts.docId, sessionId: this.#sessionId, seq, claimedAtMs: clock(), payload: update }, this.#opts.key);
    this.#sent.set(seq, t0);
    this.#ws.send(bytes);
    return { update, t0 };
  }

  get unacked(): number {
    return this.#sent.size;
  }

  close(): Promise<void> {
    if (this.#ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      this.#ws.once("close", () => resolve());
      this.#ws.terminate();
    });
  }
}

/** Map key for correlating an update seen by a probe with the time its sender made it. */
export const updateKey = (u: Uint8Array): string => Buffer.from(u).toString("base64");

/**
 * One cold sync as a client would do it, with a decoder that accepts large frames: opens the socket, sends SYNC_1 for an
 * empty document, waits for SYNC_2 and applies it to a fresh replica. The stock `GatewayClient` used to decode with the
 * default 1 MiB payload cap and silently drop a larger SYNC_2 (ticket L1, fixed in docs/specs/large-sync.md); this
 * measures the gateway's side of the load without the client's decoding in it. The clock starts before the socket is opened and stops after the replica has applied the state.
 */
export async function coldSync(opts: { url: string; docId: string; actor: number; engine: EngineName; timeoutMs: number }): Promise<{ ms: number; textLength: number; payloadBytes: number }> {
  const t0 = performance.now();
  const doc = getEngine(opts.engine).create(opts.actor);
  const ws = new WebSocket(`${opts.url}/doc/${encodeURIComponent(opts.docId)}`, { maxPayload: 512 * 1024 * 1024 });
  try {
    const payloadBytes = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no SYNC_2 within ${opts.timeoutMs} ms`)), opts.timeoutMs);
      ws.once("error", (e) => reject(e));
      ws.once("close", () => reject(new Error("closed before SYNC_2")));
      ws.once("open", () => ws.send(encodeFrame({ type: FrameType.SYNC_1, flags: 0, sessionId: 1, seq: 0, payload: doc.encodeStateVector() })));
      ws.on("message", (data: Buffer) => {
        const frame = decodeFrame(new Uint8Array(data), { maxPayloadBytes: 512 * 1024 * 1024 });
        if (frame.type !== FrameType.SYNC_2) return;
        clearTimeout(timer);
        doc.applyUpdate(frame.payload);
        resolve(frame.payload.length);
      });
    });
    return { ms: performance.now() - t0, textLength: doc.getText().length, payloadBytes };
  } finally {
    ws.terminate();
    doc.destroy();
  }
}
