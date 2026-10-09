import WebSocket from "ws";
import { getEngine, type EngineDoc, type EngineName, type Json, type Path } from "@omnisync/engine";
import { encodeAuthResponse } from "@omnisync/crypto";
import { FrameType, decodeFrame, describeDecodeError, encodeFrame, resolveInboundCap, signUpdate, type KeyPair } from "@omnisync/protocol";
import { ROLES, type Role } from "@omnisync/store";

/**
 * Node client used by tests, the demo and the benchmark. The browser SDK
 * (packages/sdk, week 7) adds 50-250 ms batching and an IndexedDB queue; the
 * protocol behaviour here is the reference for it:
 *
 *  - every edit is signed when it is made and queued until acknowledged;
 *  - on (re)connect: SYNC_1/SYNC_2, then resend the unacknowledged queue in order;
 *  - reconnect with exponential backoff and full jitter, capped (default 30 s);
 *  - server hints (`busy;retry_after_ms=N`) raise the delay floor;
 *  - retryable errors (`unavailable`, `rate_limited`) keep the update queued; terminal ones reject it;
 *  - with a certificate the client answers the gateway's AUTH_CHALLENGE before anything else; a
 *    permanent refusal (revoked, expired, no access) stops reconnecting and rejects queued edits;
 *  - a certificate past its life but inside the grace window connects "upload only": queued edits
 *    are delivered, nothing is read back.
 */
export interface ClientOptions {
  url: string;
  docId: string;
  actor: number;
  key: KeyPair;
  engine?: EngineName;
  sessionId?: number;
  /** Reconnect after a dropped connection (default true). */
  reconnect?: boolean;
  backoff?: { baseMs?: number; maxMs?: number };
  /** Give up on a handshake that gets no SYNC_2 within this time (default 5 s). */
  syncTimeoutMs?: number;
  /** Injectable for deterministic tests. */
  random?: () => number;
  /** Session certificate for `key`, as issued by the control plane. Required by gateways with auth enabled. */
  certificate?: Uint8Array;
  /** Wall clock used to stamp edits (signed into each UPDATE). Injectable for tests. */
  clock?: () => number;
  /**
   * Largest frame accepted from the gateway, in bytes (default and maximum 64 MiB). The first sync carries the whole
   * document, so a cap below the document's size makes it unopenable; such a frame is dropped and reported
   * (`decodeErrors`, `onDecodeError`). Edits the client sends are capped by the gateway at 1 MiB regardless.
   */
  maxInboundBytes?: number;
  /** Called with a short description (code and sizes, never bytes) each time a received frame is dropped. */
  onDecodeError?: (error: string) => void;
}

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (e: Error) => void;
}

interface Queued {
  readonly bytes: Uint8Array;
  readonly resolve: () => void;
  readonly reject: (e: Error) => void;
}

const RETRYABLE = new Set(["unavailable", "internal", "rate_limited"]);
/** Handshake refusals that may clear on their own; everything else is permanent. */
const AUTH_RETRYABLE = new Set(["unavailable", "timeout"]);

export class GatewayClient {
  readonly doc: EngineDoc;
  readonly errors: string[] = [];
  /** Delays chosen by the backoff so far, for tests and diagnostics. */
  readonly delays: number[] = [];
  reconnects = 0;
  /** Frames received from the gateway and dropped because they could not be decoded or were over `maxInboundBytes`. */
  decodeErrors = 0;
  lastDecodeError: string | undefined;
  /** Role and mode the gateway granted on the current connection (certificate mode only). */
  role: Role | undefined;
  mode: "full" | "upload_only" = "full";
  /** Set when the gateway permanently refused this identity. */
  authFailure: string | undefined;
  /** Server clock minus local clock at the last handshake, ms. Large values break edit timestamps. */
  serverSkewMs = 0;

  readonly #opts: ClientOptions;
  readonly #inboundCap: number;
  readonly #sessionId: number;
  readonly #outbox = new Map<number, Queued>();
  readonly #random: () => number;
  #ws: WebSocket | undefined;
  #seq = 0;
  #synced = false;
  #closed = false;
  #attempt = 0;
  #delayFloor = 0;
  #timer: NodeJS.Timeout | undefined;
  #syncTimer: NodeJS.Timeout | undefined;
  #syncWaiters: Waiter[] = [];
  readonly #clock: () => number;
  #onRemote: ((update: Uint8Array) => void) | undefined;

  private constructor(opts: ClientOptions) {
    this.#inboundCap = resolveInboundCap(opts.maxInboundBytes);
    this.#opts = opts;
    this.#sessionId = opts.sessionId ?? Math.floor(Math.random() * 2 ** 31);
    this.#random = opts.random ?? Math.random;
    this.#clock = opts.clock ?? Date.now;
    this.doc = getEngine(opts.engine ?? "yjs").create(opts.actor);
  }

  /** Connects and completes the first sync. Rejects if the first connection attempt fails. */
  static async connect(opts: ClientOptions): Promise<GatewayClient> {
    const client = new GatewayClient(opts);
    await new Promise<void>((resolve, reject) => {
      const ws = client.#open();
      ws.once("error", reject);
      ws.once("open", () => {
        ws.off("error", reject);
        resolve();
      });
    });
    await client.#waitSynced();
    return client;
  }

  get connected(): boolean {
    return this.#synced;
  }

  /** Signed updates not yet acknowledged by the gateway. */
  get unacked(): number {
    return this.#outbox.size;
  }

  onRemoteUpdate(fn: (update: Uint8Array) => void): void {
    this.#onRemote = fn;
  }

  /** Resolves when the gateway has durably stored the edit. Works while offline: it is queued and signed now. */
  insert(index: number, text: string): Promise<void> {
    return this.#publish(this.doc.insertText(index, text));
  }

  delete(index: number, length: number): Promise<void> {
    return this.#publish(this.doc.deleteText(index, length));
  }

  /** Structured data edits (maps and arrays). Same contract as `insert`: signed now, resolved when stored. */
  mapSet(path: Path, key: string, value: Json): Promise<void> {
    return this.#publish(this.doc.mapSet(path, key, value));
  }

  mapDelete(path: Path, key: string): Promise<void> {
    return this.#publish(this.doc.mapDelete(path, key));
  }

  arrayInsert(path: Path, index: number, values: readonly Json[]): Promise<void> {
    return this.#publish(this.doc.arrayInsert(path, index, values));
  }

  arrayDelete(path: Path, index: number, count: number): Promise<void> {
    return this.#publish(this.doc.arrayDelete(path, index, count));
  }

  /** SYNC_1 → SYNC_2: pulls everything the gateway has that this replica lacks. */
  sync(): Promise<void> {
    const done = new Promise<void>((resolve, reject) => this.#syncWaiters.push({ resolve, reject }));
    this.#sendSync1();
    return done;
  }

  /** Sends raw bytes: for tests that need to forge or replay frames. */
  sendRaw(bytes: Uint8Array): void {
    this.#ws?.send(bytes);
  }

  /** Simulates a network failure: the socket dies without a close handshake. Reconnect logic takes over. */
  dropConnection(): void {
    this.#ws?.terminate();
  }

  /** Intentional shutdown. Pending edits are rejected; no reconnect. */
  close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    clearTimeout(this.#syncTimer);
    for (const q of this.#outbox.values()) q.reject(new Error("client closed"));
    this.#outbox.clear();
    const ws = this.#ws;
    if (!ws || ws.readyState === ws.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      ws.once("close", () => resolve());
      ws.terminate();
    });
  }

  // ----- internals ---------------------------------------------------------

  #publish(payload: Uint8Array): Promise<void> {
    const seq = ++this.#seq;
    const bytes = signUpdate({ docId: this.#opts.docId, sessionId: this.#sessionId, seq, claimedAtMs: this.#clock(), payload }, this.#opts.key);
    const p = new Promise<void>((resolve, reject) => this.#outbox.set(seq, { bytes, resolve, reject }));
    p.catch(() => {}); // the caller may ignore it; that must not become an unhandled rejection
    if (this.#synced) this.#ws?.send(bytes);
    return p;
  }

  #open(): WebSocket {
    const ws = new WebSocket(`${this.#opts.url}/doc/${encodeURIComponent(this.#opts.docId)}`);
    this.#ws = ws;
    this.#synced = false;
    ws.on("open", () => {
      if (this.#ws !== ws) return;
      // With a certificate the gateway speaks first (AUTH_CHALLENGE); the sync handshake follows the AUTH_RESULT.
      if (!this.#opts.certificate) this.#sendSync1();
      this.#armSyncTimeout(ws);
    });
    ws.on("message", (data: Buffer) => {
      if (this.#ws === ws) this.#onMessage(new Uint8Array(data));
    });
    ws.on("error", () => {}); // 'close' always follows and drives reconnect
    ws.on("close", () => {
      if (this.#ws !== ws) return;
      this.#synced = false;
      clearTimeout(this.#syncTimer);
      if (!this.#closed && this.#opts.reconnect !== false) this.#scheduleReconnect();
      else if (!this.#synced) {
        // Nobody will retry for the caller: say why the handshake ended instead of waiting forever.
        const err = new Error(`connection closed before sync: ${this.errors.at(-1) ?? (this.lastDecodeError !== undefined ? `dropped frame (${this.decodeErrors} dropped, last: ${this.lastDecodeError})` : "no reason given")}`);
        for (const w of this.#syncWaiters.splice(0)) w.reject(err);
      }
    });
    return ws;
  }

  #sendSync1(): void {
    const ws = this.#ws;
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(encodeFrame({ type: FrameType.SYNC_1, flags: 0, sessionId: this.#sessionId, seq: 0, payload: this.doc.encodeStateVector() }));
  }

  #armSyncTimeout(ws: WebSocket): void {
    clearTimeout(this.#syncTimer);
    this.#syncTimer = setTimeout(() => {
      if (this.#ws === ws && !this.#synced) ws.terminate(); // a handshake that never answers is a dead peer
    }, this.#opts.syncTimeoutMs ?? 5000);
  }

  #scheduleReconnect(): void {
    const base = this.#opts.backoff?.baseMs ?? 250;
    const cap = this.#opts.backoff?.maxMs ?? 30_000;
    // Full jitter: uniform in [0, min(cap, base * 2^attempt)].
    const ceiling = Math.min(cap, base * 2 ** Math.min(this.#attempt, 20));
    const delay = Math.max(Math.floor(this.#random() * ceiling), this.#delayFloor);
    this.#delayFloor = 0;
    this.#attempt++;
    this.delays.push(delay);
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      if (this.#closed) return;
      this.reconnects++;
      this.#open();
    }, delay);
  }

  /** A frame from the gateway that cannot be used is dropped, never thrown past this boundary, but it is counted and named. */
  #dropped(e: unknown): void {
    const what = describeDecodeError(e);
    this.decodeErrors++;
    this.lastDecodeError = what;
    try {
      this.#opts.onDecodeError?.(what);
    } catch {
      // a faulty observer must not break the connection
    }
  }

  #onMessage(bytes: Uint8Array): void {
    let frame;
    try {
      frame = decodeFrame(bytes, { maxPayloadBytes: this.#inboundCap });
    } catch (e) {
      this.#dropped(e);
      return;
    }
    switch (frame.type) {
      case FrameType.AUTH_CHALLENGE: {
        const cert = this.#opts.certificate;
        if (!cert) return;
        this.serverSkewMs = frame.claimedAtMs - this.#clock();
        this.#ws?.send(
          encodeFrame({
            type: FrameType.AUTH_RESPONSE,
            flags: 0,
            sessionId: 0,
            seq: 0,
            payload: encodeAuthResponse(cert, this.#opts.key.secretKey, this.#opts.docId, frame.payload),
          }),
        );
        return;
      }
      case FrameType.AUTH_RESULT: {
        const first = this.role === undefined || !this.#synced;
        this.role = ROLES[frame.payload[0] ?? 0];
        this.mode = frame.payload[1] === 1 ? "upload_only" : "full";
        if (!first) return; // a mid-session change of role or mode
        if (this.mode === "full") this.#sendSync1();
        else this.#markSynced(); // nothing to read in upload-only mode: deliver the queue and stop
        return;
      }
      case FrameType.SYNC_2:
        this.doc.applyUpdate(frame.payload);
        this.#markSynced();
        return;
      case FrameType.UPDATE:
        // Relayed peer edit. Phase 1: verify the peer signature client-side too.
        this.doc.applyUpdate(frame.payload);
        this.#onRemote?.(frame.payload);
        return;
      case FrameType.ACK: {
        const q = this.#outbox.get(frame.seq);
        if (q) {
          this.#outbox.delete(frame.seq);
          q.resolve();
        }
        return;
      }
      case FrameType.ERROR:
        this.#onError(new TextDecoder().decode(frame.payload), frame.seq);
        return;
      default:
        return;
    }
  }

  #markSynced(): void {
    clearTimeout(this.#syncTimer);
    this.#synced = true;
    this.#attempt = 0;
    // Resend everything unacknowledged, oldest first. Duplicates are ACKed again by the gateway.
    for (const q of this.#outbox.values()) this.#ws?.send(q.bytes);
    for (const w of this.#syncWaiters.splice(0)) w.resolve();
  }

  /** The gateway refused this identity for good: stop retrying and fail everything waiting. */
  #fail(reason: string): void {
    this.authFailure = reason;
    this.#closed = true;
    clearTimeout(this.#timer);
    clearTimeout(this.#syncTimer);
    const err = new Error(`gateway refused authentication: ${reason}`);
    for (const q of this.#outbox.values()) q.reject(err);
    this.#outbox.clear();
    for (const w of this.#syncWaiters.splice(0)) w.reject(err);
    this.#ws?.close();
  }

  #onError(reason: string, seq: number): void {
    this.errors.push(reason);
    const [code, ...hints] = reason.split(";");
    if (code === "auth_failed") {
      const why = hints[0] ?? "unknown";
      if (!AUTH_RETRYABLE.has(why)) this.#fail(why);
      return; // retryable: the gateway closes the socket and the normal reconnect takes over
    }
    const retryAfter = Number(/retry_after_ms=(\d+)/.exec(hints.join(";"))?.[1] ?? 0);

    if (code === "busy") {
      // The gateway is shedding catch-up load: ask again later on the same socket.
      this.#delayFloor = retryAfter;
      this.#later(retryAfter, () => this.#sendSync1());
      return;
    }
    if (code !== undefined && RETRYABLE.has(code)) {
      // Nothing was stored. Keep the update queued and resend the queue after a backoff.
      this.#later(Math.max(retryAfter, Math.floor(this.#random() * 250)), () => {
        if (!this.#synced) return;
        for (const q of this.#outbox.values()) this.#ws?.send(q.bytes);
      });
      return;
    }
    const q = this.#outbox.get(seq);
    if (q) {
      this.#outbox.delete(seq);
      q.reject(new Error(`rejected by gateway: ${reason}`));
    }
  }

  #later(ms: number, fn: () => void): void {
    setTimeout(() => {
      if (!this.#closed) fn();
    }, ms).unref();
  }

  #waitSynced(): Promise<void> {
    if (this.authFailure) return Promise.reject(new Error(`gateway refused authentication: ${this.authFailure}`));
    if (this.#synced) return Promise.resolve();
    return new Promise((resolve, reject) => this.#syncWaiters.push({ resolve, reject }));
  }
}
