import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { getEngine, type EngineName, type SyncEngine } from "@omnisync/engine";
import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  FrameType,
  decodeFrame,
  encodeFrame,
  verifyUpdate,
  type Frame,
  type KeyResolver,
} from "@omnisync/protocol";
import { MemoryDocumentStore, MemoryObjectStore, type DocumentStore, type ObjectStore } from "@omnisync/store";
import { Room, type Log, type RoomStats } from "./room.js";

/**
 * Gateway (spec: docs/specs/gateway-core.md).
 *
 * Accepts from clients: SYNC_1 (state vector), UPDATE (signed), AWARENESS.
 * Sends to clients:     SYNC_2 (diff), UPDATE (relayed as received), AWARENESS, ACK, ERROR.
 *
 * Every UPDATE is verified, then made durable in the update log, and only then
 * applied, relayed and acknowledged. Clients can never push unsigned bulk
 * state (no client SYNC_2). Snapshots are a cache over the log.
 */

/** Messages a connection may queue while its document is still cold-loading. */
const MAX_LOAD_BACKLOG = 4096;
const PATH = /^\/doc\/([A-Za-z0-9._~-]{1,128})$/;

export interface GatewayOptions {
  port?: number;
  host?: string;
  engine?: EngineName;
  resolveKey: KeyResolver;
  maxPayloadBytes?: number;
  /** Defaults to an in-memory store (nothing survives a restart). */
  store?: DocumentStore;
  objects?: ObjectStore;
  /** Snapshot after this many updates (default 500). */
  compactEveryUpdates?: number;
  /** Snapshot a document with unsnapshotted updates after this long (default 5 min). */
  compactEveryMs?: number;
  /** Evict a document with no clients after this long (default 60 s). */
  idleEvictMs?: number;
  /** Concurrent SYNC_1 responses in flight before answering `busy` (default 16). */
  maxConcurrentCatchUps?: number;
  /** Wait after a failed snapshot before retrying (default 5 s). */
  compactRetryMs?: number;
  /** Abandon one object-store or snapshot-metadata call after this long (default 10 s). */
  objectTimeoutMs?: number;
  /** Largest AWARENESS payload relayed (default 16 KiB). */
  maxAwarenessBytes?: number;
  /**
   * Browser origins allowed to open a WebSocket. A request that carries an Origin header is
   * refused unless it is listed (or this is "*"). Node clients send no Origin and are unaffected.
   */
  allowedOrigins?: readonly string[] | "*";
  /** Largest group-commit batch (default 256). */
  maxBatch?: number;
  /** Background sweep period for time-based compaction and eviction (default 1 s). */
  sweepMs?: number;
  /** WebSocket ping period; unresponsive peers are dropped (default 30 s, 0 disables). */
  heartbeatMs?: number;
  /** Structured events. Never receives keys or document content. */
  log?: Log;
}

export interface GatewayStats extends RoomStats {
  documents: number;
  connections: number;
  accepted: number;
  rejected: Record<string, number>;
  evictions: number;
  busyRejections: number;
  catchUpsInFlight: number;
  degraded: boolean;
}

type Resolved = Required<Omit<GatewayOptions, "store" | "objects" | "log" | "engine" | "port" | "host">>;

export class Gateway {
  readonly #engine: SyncEngine;
  readonly #rooms = new Map<string, Room>();
  readonly #store: DocumentStore;
  readonly #objects: ObjectStore;
  readonly #host: string;
  readonly #port: number;
  readonly #o: Resolved;
  readonly #log: Log;
  readonly #stats: RoomStats & { accepted: number; rejected: Record<string, number>; evictions: number; busyRejections: number } = {
    persisted: 0,
    duplicates: 0,
    snapshots: 0,
    snapshotFailures: 0,
    snapshotFallbacks: 0,
    poisonUpdates: 0,
    loads: 0,
    accepted: 0,
    rejected: {},
    evictions: 0,
    busyRejections: 0,
  };
  #connections = 0;
  #catchUps = 0;
  #degraded = false;
  #http: Server | undefined;
  #wss: WebSocketServer | undefined;
  #timers: NodeJS.Timeout[] = [];
  readonly #evicting = new Set<Promise<void>>();

  constructor(opts: GatewayOptions) {
    this.#engine = getEngine(opts.engine ?? "yjs");
    this.#store = opts.store ?? new MemoryDocumentStore();
    this.#objects = opts.objects ?? new MemoryObjectStore();
    this.#host = opts.host ?? "127.0.0.1";
    this.#port = opts.port ?? 0;
    this.#log = opts.log ?? (() => {});
    this.#o = {
      resolveKey: opts.resolveKey,
      maxPayloadBytes: opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
      compactEveryUpdates: opts.compactEveryUpdates ?? 500,
      compactEveryMs: opts.compactEveryMs ?? 5 * 60_000,
      idleEvictMs: opts.idleEvictMs ?? 60_000,
      maxConcurrentCatchUps: opts.maxConcurrentCatchUps ?? 16,
      maxBatch: opts.maxBatch ?? 256,
      compactRetryMs: opts.compactRetryMs ?? 5000,
      objectTimeoutMs: opts.objectTimeoutMs ?? 10_000,
      maxAwarenessBytes: opts.maxAwarenessBytes ?? 16 * 1024,
      allowedOrigins: opts.allowedOrigins ?? [],
      sweepMs: opts.sweepMs ?? 1000,
      heartbeatMs: opts.heartbeatMs ?? 30_000,
    };
  }

  get stats(): GatewayStats {
    return {
      ...this.#stats,
      rejected: { ...this.#stats.rejected },
      documents: this.#rooms.size,
      connections: this.#connections,
      catchUpsInFlight: this.#catchUps,
      degraded: this.#degraded,
    };
  }

  /** Current in-memory text of a resident document, for tests and the demo. */
  textOf(docId: string): string | undefined {
    const room = this.#rooms.get(docId);
    return room?.doc?.getText();
  }

  isResident(docId: string): boolean {
    return this.#rooms.has(docId);
  }

  /** Runs the background sweep once. Exposed so tests do not depend on timers. */
  async sweep(now = Date.now()): Promise<void> {
    const work: Promise<unknown>[] = [];
    for (const [docId, room] of this.#rooms) {
      if (room.doc === undefined) continue; // still loading
      if (room.clients.size === 0 && room.idleSince !== undefined && now - room.idleSince >= this.#o.idleEvictMs && !room.busy) {
        work.push(this.#evict(docId, room));
      } else if (room.updatesSinceSnapshot > 0 && now - room.lastSnapshotAt >= this.#o.compactEveryMs) {
        work.push(room.compact());
      }
    }
    await Promise.allSettled(work);
  }

  async listen(): Promise<number> {
    const http = createServer((req, res) => void this.#handleHttp(req.url ?? "/", res));
    // Frame overhead is small; allow 4 KiB above the payload cap.
    const wss = new WebSocketServer({ noServer: true, maxPayload: this.#o.maxPayloadBytes + 4096 });
    http.on("upgrade", (req, socket, head) => {
      const docId = parseDocId(req);
      if (docId === undefined) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      if (!this.#originAllowed(req)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.#onConnection(ws, docId));
    });
    this.#http = http;
    this.#wss = wss;
    this.#timers.push(setInterval(() => void this.sweep(), this.#o.sweepMs).unref());
    if (this.#o.heartbeatMs > 0) this.#timers.push(setInterval(() => this.#heartbeat(), this.#o.heartbeatMs).unref());
    await new Promise<void>((resolve) => http.listen(this.#port, this.#host, resolve));
    const addr = http.address();
    if (addr === null || typeof addr === "string") throw new Error("gateway failed to bind");
    return addr.port;
  }

  /** Stops accepting connections, drains queued writes, snapshots dirty documents. Does not close the store. */
  async close(): Promise<void> {
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    for (const client of this.#wss?.clients ?? []) client.terminate();
    await new Promise<void>((resolve) => (this.#wss ? this.#wss.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (this.#http ? this.#http.close(() => resolve()) : resolve()));
    await Promise.allSettled([...this.#evicting]);
    const rooms = [...this.#rooms.values()];
    this.#rooms.clear();
    await Promise.allSettled(rooms.map((r) => r.ready.then(() => r.destroy({ finalSnapshot: true }))));
  }

  /**
   * Test hook that simulates `kill -9`: sockets die and timers stop, but
   * nothing is flushed, drained or snapshotted. Whatever was not already
   * committed to the store is gone, exactly as after a real crash.
   */
  async crash(): Promise<void> {
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    for (const client of this.#wss?.clients ?? []) client.terminate();
    await new Promise<void>((resolve) => (this.#wss ? this.#wss.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (this.#http ? this.#http.close(() => resolve()) : resolve()));
    this.#rooms.clear();
  }

  async #handleHttp(url: string, res: ServerResponse): Promise<void> {
    if (url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, engine: this.#engine.name, ...this.stats }));
    } else if (url === "/readyz") {
      try {
        await this.#store.ping();
        this.#degraded = false;
        res.writeHead(200).end("ready");
      } catch {
        this.#degraded = true;
        res.writeHead(503).end("store unavailable");
      }
    } else {
      res.writeHead(404).end();
    }
  }

  // ----- rooms -------------------------------------------------------------

  #room(docId: string): Room {
    let room = this.#rooms.get(docId);
    if (!room) {
      const created: Room = new Room({
        docId,
        engine: this.#engine,
        store: this.#store,
        objects: this.#objects,
        config: {
          compactEveryUpdates: this.#o.compactEveryUpdates,
          maxBatch: this.#o.maxBatch,
          compactRetryMs: this.#o.compactRetryMs,
          objectTimeoutMs: this.#o.objectTimeoutMs,
        },
        stats: this.#stats,
        log: this.#log,
        onStoreHealth: (ok) => {
          this.#degraded = !ok;
        },
      });
      // A failed load must not leave a poisoned room behind: the next connection retries.
      created.ready.catch(() => {
        if (this.#rooms.get(docId) === created) this.#rooms.delete(docId);
      });
      this.#rooms.set(docId, created);
      room = created;
    }
    return room;
  }

  async #evict(docId: string, room: Room): Promise<void> {
    // Remove first: a connection arriving now cold-loads a fresh room from the durable log.
    this.#rooms.delete(docId);
    const p = room
      .destroy({ finalSnapshot: true })
      .then(() => {
        this.#stats.evictions++;
        this.#log("room_evicted", { docId });
      })
      .catch(() => {});
    this.#evicting.add(p);
    await p;
    this.#evicting.delete(p);
  }

  // ----- connections ---------------------------------------------------------

  #onConnection(ws: WebSocket, docId: string): void {
    ws.binaryType = "nodebuffer";
    const room = this.#room(docId);
    room.clients.add(ws);
    room.idleSince = undefined;
    this.#connections++;
    (ws as WebSocket & { alive?: boolean }).alive = true;
    ws.on("pong", () => ((ws as WebSocket & { alive?: boolean }).alive = true));

    // Messages that arrive while the document is still loading are processed in order afterwards.
    let ready = false;
    const backlog: Uint8Array[] = [];
    room.ready.then(
      () => {
        ready = true;
        for (const bytes of backlog.splice(0)) this.#onMessage(ws, docId, room, bytes);
      },
      () => ws.close(1013, "document unavailable"),
    );

    ws.on("message", (data, isBinary) => {
      if (!isBinary) return this.#reject(ws, "text_frame");
      const bytes = toBytes(data);
      if (ready) this.#onMessage(ws, docId, room, bytes);
      else if (backlog.length < MAX_LOAD_BACKLOG) backlog.push(bytes);
      else ws.close(1013, "too many messages while loading");
    });
    ws.on("close", () => {
      room.clients.delete(ws);
      this.#connections--;
      if (room.clients.size === 0) room.idleSince = Date.now();
    });
    ws.on("error", () => ws.terminate());
  }

  #originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin === undefined) return true; // not a browser
    const allowed = this.#o.allowedOrigins;
    return allowed === "*" || allowed.includes(origin);
  }

  #heartbeat(): void {
    for (const ws of this.#wss?.clients ?? []) {
      const w = ws as WebSocket & { alive?: boolean };
      if (w.alive === false) {
        ws.terminate();
        continue;
      }
      w.alive = false;
      ws.ping();
    }
  }

  #onMessage(ws: WebSocket, docId: string, room: Room, bytes: Uint8Array): void {
    let frame: Frame;
    try {
      frame = decodeFrame(bytes, { maxPayloadBytes: this.#o.maxPayloadBytes });
    } catch {
      return this.#reject(ws, "malformed");
    }

    switch (frame.type) {
      case FrameType.SYNC_1:
        return this.#catchUp(ws, room, frame);
      case FrameType.UPDATE:
        return this.#update(ws, docId, room, bytes);
      case FrameType.AWARENESS:
        // Presence is relayed, never stored or applied, and capped so it cannot be used to flood peers.
        if (frame.payload.length > this.#o.maxAwarenessBytes) return this.#reject(ws, "awareness_too_large");
        for (const peer of room.clients) if (peer !== ws && peer.readyState === peer.OPEN) peer.send(bytes);
        return;
      default:
        return this.#reject(ws, "type_not_allowed");
    }
  }

  #catchUp(ws: WebSocket, room: Room, frame: Frame): void {
    if (this.#catchUps >= this.#o.maxConcurrentCatchUps) {
      this.#stats.busyRejections++;
      const retryAfter = 250 + Math.floor(Math.random() * 750);
      return this.#reject(ws, `busy;retry_after_ms=${retryAfter}`, 0, false);
    }
    let diff: Uint8Array;
    try {
      diff = room.doc.encodeDiff(frame.payload);
    } catch {
      return this.#reject(ws, "bad_state_vector");
    }
    if (ws.readyState !== ws.OPEN) return;
    // The slot is held until the bytes are flushed to the socket, which is what a stampede exhausts.
    this.#catchUps++;
    ws.send(encodeFrame({ type: FrameType.SYNC_2, flags: 0, sessionId: 0, seq: 0, payload: diff }), () => {
      this.#catchUps--;
    });
  }

  #update(ws: WebSocket, docId: string, room: Room, bytes: Uint8Array): void {
    const result = verifyUpdate(bytes, docId, this.#o.resolveKey, { maxPayloadBytes: this.#o.maxPayloadBytes });
    if (!result.ok) return this.#reject(ws, result.reason);
    const { frame } = result;
    room.submit({
      frame,
      bytes,
      accepted: (_seq, fresh) => {
        if (fresh) {
          this.#stats.accepted++;
          for (const peer of room.clients) if (peer !== ws && peer.readyState === peer.OPEN) peer.send(bytes);
        }
        send(ws, { type: FrameType.ACK, flags: 0, sessionId: frame.sessionId, seq: frame.seq, payload: new Uint8Array() });
      },
      rejected: (reason) => this.#reject(ws, reason, frame.seq),
    });
  }

  #reject(ws: WebSocket, reason: string, seq = 0, count = true): void {
    if (count) {
      const bucket = reason.split(";")[0] as string;
      this.#stats.rejected[bucket] = (this.#stats.rejected[bucket] ?? 0) + 1;
    }
    send(ws, { type: FrameType.ERROR, flags: 0, sessionId: 0, seq, payload: new TextEncoder().encode(reason) });
  }
}

function send(ws: WebSocket, frame: Parameters<typeof encodeFrame>[0]): void {
  if (ws.readyState === ws.OPEN) ws.send(encodeFrame(frame));
}

function parseDocId(req: IncomingMessage): string | undefined {
  const path = new URL(req.url ?? "/", "http://gateway").pathname;
  return PATH.exec(path)?.[1];
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
