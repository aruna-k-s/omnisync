import { decodeCertificate, encodeAuthResponseWith } from "@omnisync/crypto";
import type { EngineDoc, Json, Path, SyncEngine } from "@omnisync/engine";
import { FrameType, decodeFrame, encodeFrame, signUpdateWith } from "@omnisync/protocol";
import { backoffDelay } from "./backoff.js";
import { Batcher } from "./batcher.js";
import type { DeviceKey } from "./keys.js";
import { newSessionId, type Outbox, type OutboxFrame } from "./outbox.js";

export type ConnectionState = "idle" | "connecting" | "authenticating" | "syncing" | "online" | "offline" | "closed" | "error";

export interface Status {
  readonly state: ConnectionState;
  /** `upload_only`: the certificate has lapsed within the grace window; the outbox drains and nothing is read. */
  readonly mode: "full" | "upload_only";
  /** Why the state is `closed` or `error`. */
  readonly reason?: string;
}

export interface DocumentOptions {
  /** Gateway base URL, e.g. `wss://sync.example.com`. The document path is added. */
  url: string;
  docId: string;
  key: DeviceKey;
  /** Session certificate for `key`. Omit only against a gateway with authentication off. */
  certificate?: Uint8Array;
  outbox: Outbox;
  engine: SyncEngine;
  actor?: number;
  WebSocket?: typeof WebSocket;
  clock?: () => number;
  random?: () => number;
  batch?: { minMs?: number; maxMs?: number };
  backoff?: { baseMs?: number; maxMs?: number; stableMs?: number };
  syncTimeoutMs?: number;
  /** Past this long after expiry the SDK stops connecting (the gateway's own grace window decides upload-only). Default 72 h. */
  certificateGraceMs?: number;
  /** Wait this long after a quiet change before saving a local copy of the document (default 1000 ms). */
  snapshotDelayMs?: number;
  /** Fired once, this long before the certificate expires (default 10 minutes). */
  onCertificateExpiring?: () => void;
  certificateWarningMs?: number;
  /** Flush on pagehide / hidden (default true where the page has those events). */
  flushOnPageHide?: boolean;
  /** Start connecting at once (default true). */
  autoConnect?: boolean;
}

export type ChangeSource = "local" | "remote";

const RETRYABLE = new Set(["unavailable", "internal", "rate_limited"]);
const AUTH_RETRYABLE = new Set(["unavailable", "timeout"]);
const TERMINAL_CLOSE = new Set([4401, 4403]);
const HOUR = 3_600_000;

interface Edit {
  readonly payload: Uint8Array;
  readonly claimedAtMs: number;
}

/** The document refused further edits after a failure that left it out of step with its outbox. */
export class DocumentFaultError extends Error {
  override readonly name = "DocumentFaultError";
  constructor(reason: string) {
    super(`document is out of step with its outbox (${reason}); reload it`);
  }
}

function errorOf(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * One open document: a local replica that applies edits at once, signs and queues them in batches,
 * and keeps the gateway connection alive. Edits made offline are delivered, in order, on reconnect.
 */
export class SyncDocument {
  readonly errors: string[] = [];
  /** Delays chosen by the backoff so far, for tests and diagnostics. */
  readonly delays: number[] = [];
  reconnects = 0;
  role: string | undefined;
  /** Server clock minus local clock at the last handshake, ms. */
  serverSkewMs = 0;
  /** Edits the gateway refused for good (they stay in this replica, but never reach the others). */
  refusedEdits = 0;

  readonly #o: DocumentOptions;
  #engineDoc!: EngineDoc;
  readonly #clock: () => number;
  readonly #random: () => number;
  readonly #WS: typeof WebSocket;
  readonly #batcher: Batcher<Edit>;
  readonly #changeFns = new Set<(source: ChangeSource) => void>();
  readonly #statusFns = new Set<(s: Status) => void>();
  readonly #errorFns = new Set<(message: string) => void>();
  #cert: Uint8Array | undefined;
  #sessionId = 0;
  #seq = 0;
  #queue: OutboxFrame[] = [];
  readonly #sent = new Set<string>();
  #pending = 0;
  #drain: { resolve: () => void; reject: (e: Error) => void }[] = [];
  #online: { resolve: () => void; reject: (e: Error) => void }[] = [];
  #status: Status = { state: "idle", mode: "full" };
  #ws: WebSocket | undefined;
  #attempt = 0;
  #delayFloor = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #syncTimer: ReturnType<typeof setTimeout> | undefined;
  #stableTimer: ReturnType<typeof setTimeout> | undefined;
  #resendTimer: ReturnType<typeof setTimeout> | undefined;
  #expiryTimer: ReturnType<typeof setTimeout> | undefined;
  #snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  /** The replica has changed (from the gateway) since the last local copy was taken. */
  #dirty = false;
  readonly #writes = new Set<Promise<void>>();
  #closed = false;
  #paused = false;
  #fault: string | undefined;
  #loaded = false;
  #hide: (() => void) | undefined;

  private constructor(opts: DocumentOptions) {
    this.#o = opts;
    this.#clock = opts.clock ?? Date.now;
    this.#random = opts.random ?? Math.random;
    this.#WS = opts.WebSocket ?? globalThis.WebSocket;
    this.#cert = opts.certificate;
    this.#batcher = new Batcher<Edit>({
      ...(opts.batch?.minMs !== undefined ? { minMs: opts.batch.minMs } : {}),
      ...(opts.batch?.maxMs !== undefined ? { maxMs: opts.batch.maxMs } : {}),
      now: this.#clock,
      flush: (edits) => this.#commit(edits),
      onError: (e, edits) => this.#failCommit(e, edits.length),
    });
  }

  /** Opens the document from its outbox. Resolves as soon as the local replica is ready: it never waits for the network. */
  static async open(opts: DocumentOptions): Promise<SyncDocument> {
    const d = new SyncDocument(opts);
    await d.#load();
    if (opts.autoConnect !== false) d.connect();
    return d;
  }

  async #load(): Promise<void> {
    const o = this.#o;
    const actor = o.actor ?? 1 + Math.floor(this.#random() * (2 ** 32 - 2));
    // Start from the last copy taken while nothing was waiting for the gateway, so an offline reload still shows the document.
    let base: Uint8Array | undefined;
    try {
      base = await o.outbox.loadSnapshot();
    } catch {
      base = undefined;
    }
    try {
      this.#engineDoc = base ? o.engine.load(base, actor) : o.engine.create(actor);
    } catch {
      this.#engineDoc = o.engine.create(actor); // a damaged copy is only a cache: the gateway sends the rest
    }
    this.#sessionId = await newSessionId(o.outbox, this.#random);
    this.#queue = await o.outbox.pending();
    // Rebuild what the user had made but the gateway had not yet confirmed.
    for (const f of this.#queue) {
      const frame = decodeFrame(f.bytes);
      this.#engineDoc.applyUpdate(frame.payload);
    }
    this.#pending = this.#queue.length;
    this.#loaded = true;
    this.#armExpiry();
    if (o.flushOnPageHide !== false) this.#watchPageHide();
  }

  // ----- reading -------------------------------------------------------------

  get text(): string {
    return this.#engineDoc.getText();
  }
  /** A deep copy of the data tree. */
  get data(): { [key: string]: Json } {
    return this.#engineDoc.getData();
  }
  get docId(): string {
    return this.#o.docId;
  }
  get status(): Status {
    return this.#status;
  }
  /** Edits made here that the gateway has not yet confirmed. */
  get pending(): number {
    return this.#pending;
  }
  get sessionId(): number {
    return this.#sessionId;
  }

  onChange(fn: (source: ChangeSource) => void): () => void {
    this.#changeFns.add(fn);
    return () => this.#changeFns.delete(fn);
  }
  onStatus(fn: (s: Status) => void): () => void {
    this.#statusFns.add(fn);
    return () => this.#statusFns.delete(fn);
  }
  /** Errors the gateway reported, as `code;hint` strings. */
  onError(fn: (message: string) => void): () => void {
    this.#errorFns.add(fn);
    return () => this.#errorFns.delete(fn);
  }

  /** Resolves when connected and synced. Rejects if the document closes or fails first. */
  online(): Promise<void> {
    if (this.#status.state === "online") return Promise.resolve();
    if (this.#closed || this.#status.state === "error" || this.#status.state === "closed") {
      return Promise.reject(new Error(this.#status.reason ?? "document closed"));
    }
    return new Promise((resolve, reject) => this.#online.push({ resolve, reject }));
  }

  /** Resolves when every edit made so far has been acknowledged. Rejects if the document can no longer deliver them. */
  synced(): Promise<void> {
    if (this.#fault !== undefined) return Promise.reject(new DocumentFaultError(this.#fault));
    void this.flush();
    if (this.#pending === 0) return Promise.resolve();
    if (this.#closed) return Promise.reject(new Error("document closed"));
    return new Promise((resolve, reject) => this.#drain.push({ resolve, reject }));
  }

  // ----- editing -------------------------------------------------------------

  insertText(index: number, text: string): void {
    this.#edit((d) => d.insertText(index, text));
  }
  deleteText(index: number, length: number): void {
    this.#edit((d) => d.deleteText(index, length));
  }
  mapSet(path: Path, key: string, value: Json): void {
    this.#edit((d) => d.mapSet(path, key, value));
  }
  mapDelete(path: Path, key: string): void {
    this.#edit((d) => d.mapDelete(path, key));
  }
  arrayInsert(path: Path, index: number, values: readonly Json[]): void {
    this.#edit((d) => d.arrayInsert(path, index, values));
  }
  arrayDelete(path: Path, index: number, count: number): void {
    this.#edit((d) => d.arrayDelete(path, index, count));
  }

  /** Applies the edit locally now (validation errors throw and change nothing), then queues it for signing. */
  #edit(make: (d: EngineDoc) => Uint8Array): void {
    if (this.#closed) throw new Error("document closed");
    if (this.#fault !== undefined) throw new DocumentFaultError(this.#fault);
    if (!this.#loaded) throw new Error("document not loaded");
    const claimedAtMs = this.#clock();
    // The moment an unconfirmed edit begins is the last time the replica equals what the gateway has confirmed:
    // keep that copy, so an offline reload shows the base and the outbox supplies the rest.
    if (this.#pending === 0 && this.#dirty) void this.#saveSnapshot();
    const payload = make(this.#engineDoc);
    this.#dirty = true;
    this.#pending++;
    this.#batcher.add({ payload, claimedAtMs });
    this.#emitChange("local");
  }

  /** Signs and stores everything made so far, and sends it if connected. */
  flush(): Promise<void> {
    return this.#batcher.flush();
  }

  async #commit(edits: Edit[]): Promise<void> {
    const { key, docId, outbox } = this.#o;
    const frames: OutboxFrame[] = [];
    let seq = this.#seq;
    for (const e of edits) {
      seq++;
      const bytes = await signUpdateWith({ docId, sessionId: this.#sessionId, seq, claimedAtMs: e.claimedAtMs, payload: e.payload }, key.keyId, (m) => key.sign(m));
      frames.push({ sessionId: this.#sessionId, seq, bytes, claimedAtMs: e.claimedAtMs });
    }
    await outbox.append(frames);
    this.#seq = seq;
    this.#queue.push(...frames);
    this.#sendQueued();
  }

  /** Signing or storage failed after the edits were applied locally: the replica no longer matches the outbox. */
  #failCommit(e: Error, count: number): void {
    this.#fault = e.message;
    this.#pending -= count;
    this.#setStatus({ state: "error", mode: this.#status.mode, reason: e.message });
    this.#teardownSocket();
    const err = new DocumentFaultError(e.message);
    this.#rejectWaiters(err);
  }

  // ----- connection ----------------------------------------------------------

  /** Works offline on purpose: drops the connection and does not retry until `connect()`. Edits keep queueing. */
  disconnect(): void {
    if (this.#closed || this.#fault !== undefined) return;
    this.#paused = true;
    this.#teardownSocket();
    clearTimeout(this.#reconnectTimer);
    this.#setStatus({ state: "offline", mode: "full" });
  }

  /** Starts (or restarts) the connection. Safe to call when already connecting. */
  connect(): void {
    this.#paused = false;
    if (this.#closed || this.#fault !== undefined || this.#ws) return;
    if (this.#status.state === "closed") this.#status = { state: "idle", mode: "full" };
    const cert = this.#cert;
    if (cert) {
      const c = decodeCertificate(cert);
      const grace = this.#o.certificateGraceMs ?? 72 * HOUR;
      if (this.#clock() > c.notAfterMs + grace) return this.#terminate("certificate expired");
    }
    this.#setStatus({ state: "connecting", mode: "full" });
    let ws: WebSocket;
    try {
      ws = new this.#WS(`${this.#o.url}/doc/${encodeURIComponent(this.#o.docId)}`);
    } catch (e) {
      this.errors.push(`connect failed: ${errorOf(e).message}`);
      return this.#scheduleReconnect();
    }
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    this.#sent.clear();
    // One deadline covers the connection attempt and the handshake: a peer that never answers is a dead peer.
    this.#armSyncTimeout(ws);
    ws.addEventListener("open", () => {
      if (this.#ws !== ws) return;
      if (!this.#cert) this.#beginSync();
      else this.#setStatus({ state: "authenticating", mode: "full" });
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      if (this.#ws !== ws || !(ev.data instanceof ArrayBuffer)) return;
      void this.#onMessage(ws, new Uint8Array(ev.data)).catch((e: unknown) => this.errors.push(`handler: ${errorOf(e).message}`));
    });
    ws.addEventListener("error", () => {}); // 'close' always follows
    ws.addEventListener("close", (ev: CloseEvent) => {
      if (this.#ws !== ws) return;
      this.#ws = undefined;
      this.#sent.clear();
      clearTimeout(this.#syncTimer);
      clearTimeout(this.#stableTimer);
      clearTimeout(this.#resendTimer);
      if (this.#closed || this.#status.state === "closed" || this.#status.state === "error") return;
      if (TERMINAL_CLOSE.has(ev.code) && !AUTH_RETRYABLE.has(ev.reason)) return this.#terminate(ev.reason || `closed with code ${ev.code}`);
      this.#scheduleReconnect();
    });
  }

  /** Replaces the certificate (same device key) and reconnects. Queued edits are kept and sent under the new one. */
  setCertificate(certificate: Uint8Array): void {
    const c = decodeCertificate(certificate);
    if (c.publicKey.length !== this.#o.key.publicKey.length || c.publicKey.some((b, i) => b !== this.#o.key.publicKey[i])) {
      throw new Error("certificate is for a different device key");
    }
    this.#cert = certificate;
    this.#armExpiry();
    if (this.#closed || this.#fault !== undefined) return;
    this.#teardownSocket();
    clearTimeout(this.#reconnectTimer);
    this.#attempt = 0;
    this.#setStatus({ state: "idle", mode: "full" });
    this.connect();
  }

  #beginSync(): void {
    this.#setStatus({ state: "syncing", mode: this.#status.mode });
    this.#sendSync1();
  }

  #sendSync1(): void {
    const ws = this.#ws;
    if (ws?.readyState !== this.#WS.OPEN) return;
    ws.send(encodeFrame({ type: FrameType.SYNC_1, flags: 0, sessionId: this.#sessionId, seq: 0, payload: this.#engineDoc.encodeStateVector() }));
  }

  #armSyncTimeout(ws: WebSocket): void {
    clearTimeout(this.#syncTimer);
    this.#syncTimer = setTimeout(() => {
      if (this.#ws !== ws || this.#status.state === "online") return;
      // `close()` on a socket that never opened may not report back: treat the attempt as failed ourselves.
      this.#ws = undefined;
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      this.errors.push("connection attempt timed out");
      this.#scheduleReconnect();
    }, this.#o.syncTimeoutMs ?? 5000);
  }

  #scheduleReconnect(): void {
    if (this.#paused) return;
    this.#setStatus({ state: "offline", mode: "full" });
    const delay = backoffDelay({
      attempt: this.#attempt,
      baseMs: this.#o.backoff?.baseMs ?? 250,
      maxMs: this.#o.backoff?.maxMs ?? 30_000,
      floorMs: this.#delayFloor,
      random: this.#random,
    });
    this.#delayFloor = 0;
    this.#attempt++;
    this.delays.push(delay);
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => {
      if (this.#closed || this.#ws || this.#paused) return;
      this.reconnects++;
      this.connect();
    }, delay);
  }

  async #onMessage(ws: WebSocket, bytes: Uint8Array): Promise<void> {
    let frame;
    try {
      frame = decodeFrame(bytes);
    } catch {
      return;
    }
    switch (frame.type) {
      case FrameType.AUTH_CHALLENGE: {
        const cert = this.#cert;
        if (!cert) return;
        this.serverSkewMs = frame.claimedAtMs - this.#clock();
        const payload = await encodeAuthResponseWith(cert, (m) => this.#o.key.sign(m), this.#o.docId, frame.payload);
        if (this.#ws !== ws || ws.readyState !== this.#WS.OPEN) return;
        ws.send(encodeFrame({ type: FrameType.AUTH_RESPONSE, flags: 0, sessionId: 0, seq: 0, payload }));
        return;
      }
      case FrameType.AUTH_RESULT: {
        if (!this.#cert) return;
        const first = this.#status.state === "authenticating";
        this.role = ["read", "write", "merge", "admin"][frame.payload[0] ?? 0] ?? "read";
        const mode = frame.payload[1] === 1 ? "upload_only" : "full";
        if (!first) {
          this.#setStatus({ ...this.#status, mode });
          return;
        }
        if (mode === "full") {
          this.#setStatus({ state: "syncing", mode });
          this.#sendSync1();
        } else this.#goOnline("upload_only"); // nothing to read in upload-only mode: deliver the queue and stop
        return;
      }
      case FrameType.SYNC_2:
        if (this.#status.state !== "syncing") return;
        this.#engineDoc.applyUpdate(frame.payload);
        this.#dirty = true;
        this.#emitChange("remote");
        this.#goOnline("full");
        void this.#saveSnapshot(); // the base is now known: keep it for the next offline reload
        return;
      case FrameType.UPDATE:
        // Only an update that arrived over the authenticated connection, after the handshake, is applied.
        if (this.#status.state !== "online" || this.#status.mode !== "full") return;
        this.#engineDoc.applyUpdate(frame.payload);
        this.#dirty = true;
        this.#emitChange("remote");
        this.#scheduleSnapshot();
        return;
      case FrameType.ACK:
        await this.#acked(frame.sessionId, frame.seq);
        return;
      case FrameType.ERROR:
        await this.#onError(new TextDecoder().decode(frame.payload), frame.seq);
        return;
      default:
        return;
    }
  }

  /** Saves a local copy when everything made here has been confirmed, so it never holds an edit the outbox does not. */
  #saveSnapshot(): Promise<void> {
    clearTimeout(this.#snapshotTimer);
    if (this.#pending !== 0 || this.#closed || this.#fault !== undefined || this.#status.mode !== "full") return Promise.resolve();
    this.#dirty = false;
    const write = this.#o.outbox
      .saveSnapshot(this.#engineDoc.snapshot())
      .catch((e: unknown) => {
        this.errors.push(`snapshot failed: ${errorOf(e).message}`);
      })
      .finally(() => this.#writes.delete(write));
    this.#writes.add(write);
    return write;
  }

  #scheduleSnapshot(): void {
    clearTimeout(this.#snapshotTimer);
    this.#snapshotTimer = setTimeout(() => void this.#saveSnapshot(), this.#o.snapshotDelayMs ?? 1000);
    (this.#snapshotTimer as { unref?: () => void }).unref?.();
  }

  #goOnline(mode: "full" | "upload_only"): void {
    clearTimeout(this.#syncTimer);
    this.#setStatus({ state: "online", mode });
    clearTimeout(this.#stableTimer);
    // A connection that stays up proves the gateway is healthy: only then does the backoff start over.
    this.#stableTimer = setTimeout(() => (this.#attempt = 0), this.#o.backoff?.stableMs ?? 10_000);
    for (const w of this.#online.splice(0)) w.resolve();
    this.#sendQueued();
  }

  /** Sends queued frames of the oldest session that is not already on the wire. Later sessions wait their turn,
   *  so an ERROR (which carries only a seq) always names one frame. */
  #sendQueued(): void {
    const ws = this.#ws;
    if (this.#status.state !== "online" || ws?.readyState !== this.#WS.OPEN) return;
    const head = this.#queue[0];
    if (!head) return;
    for (const f of this.#queue) {
      if (f.sessionId !== head.sessionId) break;
      const k = `${f.sessionId}:${f.seq}`;
      if (this.#sent.has(k)) continue;
      this.#sent.add(k);
      ws.send(f.bytes);
    }
  }

  async #acked(sessionId: number, seq: number): Promise<void> {
    const i = this.#queue.findIndex((f) => f.sessionId === sessionId && f.seq === seq);
    if (i < 0) return; // a duplicate answer to a frame already cleared
    this.#queue.splice(i, 1);
    this.#sent.delete(`${sessionId}:${seq}`);
    this.#pending--;
    try {
      await this.#o.outbox.ack(sessionId, seq);
    } catch (e) {
      // Harmless: the frame is resent next time and the gateway answers "duplicate".
      this.errors.push(`outbox ack failed: ${errorOf(e).message}`);
    }
    this.#sendQueued();
    this.#settle();
  }

  async #onError(reason: string, seq: number): Promise<void> {
    this.errors.push(reason);
    for (const fn of this.#errorFns) fn(reason);
    const [code, ...hints] = reason.split(";");
    if (code === "auth_failed") {
      const why = hints[0] ?? "unknown";
      if (!AUTH_RETRYABLE.has(why)) this.#terminate(why);
      return; // retryable: the gateway closes the socket and the reconnect takes over
    }
    const retryAfter = Number(/retry_after_ms=(\d+)/.exec(hints.join(";"))?.[1] ?? 0);
    if (code === "busy") {
      this.#delayFloor = retryAfter;
      this.#later(retryAfter, () => this.#sendSync1());
      return;
    }
    if (code !== undefined && RETRYABLE.has(code)) {
      // Nothing was stored. Keep the frames queued and send them again after a short wait.
      clearTimeout(this.#resendTimer);
      this.#resendTimer = setTimeout(
        () => {
          this.#sent.clear();
          this.#sendQueued();
        },
        Math.max(retryAfter, Math.floor(this.#random() * 250)),
      );
      return;
    }
    const head = this.#queue[0];
    const frame = head && this.#queue.find((f) => f.sessionId === head.sessionId && f.seq === seq);
    if (!frame) return;
    if (code === "replay") {
      // The gateway only calls a frame a replay when a newer one of the same session is already stored: this one is too.
      await this.#acked(frame.sessionId, frame.seq);
      return;
    }
    // The gateway refused this edit for good. Drop it so it cannot block the ones behind it.
    this.refusedEdits++;
    await this.#acked(frame.sessionId, frame.seq);
  }

  #later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      if (!this.#closed) fn();
    }, ms);
    (t as { unref?: () => void }).unref?.();
  }

  #terminate(reason: string): void {
    this.#teardownSocket();
    clearTimeout(this.#reconnectTimer);
    this.#setStatus({ state: "closed", mode: "full", reason });
    this.#rejectWaiters(new Error(`gateway refused this identity: ${reason}`));
  }

  #teardownSocket(): void {
    const ws = this.#ws;
    this.#ws = undefined;
    this.#sent.clear();
    clearTimeout(this.#syncTimer);
    clearTimeout(this.#stableTimer);
    clearTimeout(this.#resendTimer);
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
  }

  #rejectWaiters(err: Error): void {
    for (const w of this.#online.splice(0)) w.reject(err);
    for (const w of this.#drain.splice(0)) w.reject(err);
  }

  #settle(): void {
    if (this.#pending > 0) return;
    this.#scheduleSnapshot();
    for (const w of this.#drain.splice(0)) w.resolve();
  }

  #setStatus(s: Status): void {
    const prev = this.#status;
    if (prev.state === s.state && prev.mode === s.mode && prev.reason === s.reason) return;
    this.#status = s;
    for (const fn of this.#statusFns) fn(s);
  }

  #emitChange(source: ChangeSource): void {
    for (const fn of this.#changeFns) fn(source);
  }

  #armExpiry(): void {
    clearTimeout(this.#expiryTimer);
    const fn = this.#o.onCertificateExpiring;
    if (!fn || !this.#cert) return;
    const warnAt = decodeCertificate(this.#cert).notAfterMs - (this.#o.certificateWarningMs ?? 600_000);
    const wait = warnAt - this.#clock();
    if (wait > 2 ** 31 - 1) return;
    this.#expiryTimer = setTimeout(() => fn(), Math.max(0, wait));
    (this.#expiryTimer as { unref?: () => void }).unref?.();
  }

  #watchPageHide(): void {
    const g = globalThis as { addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void; document?: { visibilityState?: string } };
    if (!g.addEventListener) return;
    const fn = (): void => {
      if (g.document?.visibilityState === undefined || g.document.visibilityState === "hidden") void this.flush();
    };
    this.#hide = fn;
    g.addEventListener("pagehide", fn);
    g.addEventListener("visibilitychange", fn);
  }

  /** Stops everything. Edits not yet acknowledged stay in the outbox for the next time the document is opened. */
  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.flush();
    } catch {
      /* a fault was already reported */
    }
    await this.#saveSnapshot(); // only if nothing is waiting for the gateway
    await Promise.allSettled([...this.#writes]);
    this.#closed = true;
    this.#batcher.dispose();
    clearTimeout(this.#snapshotTimer);
    this.#teardownSocket();
    clearTimeout(this.#reconnectTimer);
    clearTimeout(this.#expiryTimer);
    const g = globalThis as { removeEventListener?: (t: string, f: () => void) => void };
    if (this.#hide) {
      g.removeEventListener?.("pagehide", this.#hide);
      g.removeEventListener?.("visibilitychange", this.#hide);
    }
    this.#setStatus({ state: "closed", mode: this.#status.mode, reason: "closed by the application" });
    this.#rejectWaiters(new Error("document closed"));
    await this.#o.outbox.close();
    this.#engineDoc.destroy();
  }
}

