import WebSocket from "ws";
import { getEngine, type EngineDoc, type EngineName } from "@omnisync/engine";
import { FrameType, decodeFrame, encodeFrame, signUpdate, type KeyPair } from "@omnisync/protocol";

/**
 * Minimal Node client used by tests, the demo and the benchmark. The real
 * browser SDK (packages/sdk) arrives in Phase 1 week 7 with batching every
 * 50-250 ms and an offline queue; this one signs every edit immediately.
 */
export interface ClientOptions {
  url: string;
  docId: string;
  actor: number;
  key: KeyPair;
  engine?: EngineName;
  sessionId?: number;
}

export class GatewayClient {
  readonly doc: EngineDoc;
  readonly errors: string[] = [];
  readonly #ws: WebSocket;
  readonly #opts: ClientOptions;
  readonly #sessionId: number;
  #seq = 0;
  #acked = 0;
  #waiters: { seq: number; resolve: () => void }[] = [];
  #syncResolve: (() => void) | undefined;
  #onRemote: ((update: Uint8Array) => void) | undefined;

  private constructor(ws: WebSocket, opts: ClientOptions) {
    this.#ws = ws;
    this.#opts = opts;
    this.#sessionId = opts.sessionId ?? Math.floor(Math.random() * 2 ** 31);
    this.doc = getEngine(opts.engine ?? "yjs").create(opts.actor);
    ws.on("message", (data: Buffer) => this.#onMessage(new Uint8Array(data)));
  }

  static async connect(opts: ClientOptions): Promise<GatewayClient> {
    const ws = new WebSocket(`${opts.url}/doc/${encodeURIComponent(opts.docId)}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const client = new GatewayClient(ws, opts);
    await client.sync();
    return client;
  }

  /** SYNC_1 → SYNC_2: pulls everything the gateway has that this replica lacks. */
  sync(): Promise<void> {
    return new Promise((resolve) => {
      this.#syncResolve = resolve;
      this.#raw({ type: FrameType.SYNC_1, flags: 0, sessionId: this.#sessionId, seq: 0, payload: this.doc.encodeStateVector() });
    });
  }

  onRemoteUpdate(fn: (update: Uint8Array) => void): void {
    this.#onRemote = fn;
  }

  insert(index: number, text: string): Promise<void> {
    return this.#publish(this.doc.insertText(index, text));
  }

  delete(index: number, length: number): Promise<void> {
    return this.#publish(this.doc.deleteText(index, length));
  }

  /** Sends raw bytes: for tests that need to forge or replay frames. */
  sendRaw(bytes: Uint8Array): void {
    this.#ws.send(bytes);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.#ws.readyState === this.#ws.CLOSED) return resolve();
      this.#ws.once("close", () => resolve());
      this.#ws.close();
    });
  }

  #publish(payload: Uint8Array): Promise<void> {
    const seq = ++this.#seq;
    const bytes = signUpdate({ docId: this.#opts.docId, sessionId: this.#sessionId, seq, payload }, this.#opts.key);
    const acked = new Promise<void>((resolve) => this.#waiters.push({ seq, resolve }));
    this.#ws.send(bytes);
    return acked;
  }

  #raw(frame: Parameters<typeof encodeFrame>[0]): void {
    this.#ws.send(encodeFrame(frame));
  }

  #onMessage(bytes: Uint8Array): void {
    const frame = decodeFrame(bytes);
    switch (frame.type) {
      case FrameType.SYNC_2:
        this.doc.applyUpdate(frame.payload);
        this.#syncResolve?.();
        this.#syncResolve = undefined;
        return;
      case FrameType.UPDATE:
        // Relayed peer edit. Phase 1: verify the peer signature client-side too.
        this.doc.applyUpdate(frame.payload);
        this.#onRemote?.(frame.payload);
        return;
      case FrameType.ACK:
        this.#acked = Math.max(this.#acked, frame.seq);
        this.#waiters = this.#waiters.filter((w) => (w.seq <= this.#acked ? (w.resolve(), false) : true));
        return;
      case FrameType.ERROR:
        this.errors.push(new TextDecoder().decode(frame.payload));
        return;
      default:
        return;
    }
  }
}
