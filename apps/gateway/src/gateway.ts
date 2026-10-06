import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { getEngine, type EngineName, type SyncEngine } from "@omnisync/engine";
import { newNonce, serialHex, trustAnchors, verifyAuthResponse, type Certificate } from "@omnisync/crypto";
import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  FrameType,
  decodeFrame,
  encodeFrame,
  keyIdOf,
  verifyUpdate,
  type Frame,
  type KeyResolver,
} from "@omnisync/protocol";
import {
  MemoryDocumentStore,
  MemoryObjectStore,
  ROLES,
  roleAtLeast,
  type DocumentStore,
  type IdentityStore,
  type ObjectStore,
  type Role,
} from "@omnisync/store";
import { Room, type Log, type RoomStats } from "./room.js";

/**
 * Gateway (spec: docs/specs/gateway-core.md).
 *
 * Accepts from clients: AUTH_RESPONSE (when `auth` is configured), SYNC_1 (state vector), UPDATE (signed), AWARENESS.
 * Sends to clients:     AUTH_CHALLENGE, AUTH_RESULT, SYNC_2 (diff), UPDATE (relayed as received), AWARENESS, ACK, ERROR.
 *
 * Every UPDATE is verified, then made durable in the update log, and only then
 * applied, relayed and acknowledged. Clients can never push unsigned bulk
 * state (no client SYNC_2). Snapshots are a cache over the log.
 *
 * With `auth` configured (spec: docs/specs/identity.md) a connection must first
 * prove possession of a certificate issued by a trusted issuer, whose principal
 * holds a role on the document. Roles, expiry, revocation and rate limits are
 * enforced here, before anything reaches the store.
 */

/** Messages a connection may queue while its document is still cold-loading. */
const MAX_LOAD_BACKLOG = 4096;
const PATH = /^\/doc\/([A-Za-z0-9._~-]{1,128})$/;

export interface AuthOptions {
  /** Trusted issuer public keys (several during rotation). */
  issuers: readonly Uint8Array[];
  identity: IdentityStore;
  /** Gateway clock; injectable for tests. */
  now?: () => number;
  /** How long past `notAfter` a certificate may still upload edits made before it (default 72 h). */
  graceMs?: number;
  /** Largest accepted lead of a claimed edit time over the gateway clock (default 5 min). */
  maxClockSkewMs?: number;
  /** Time allowed between connecting and a valid AUTH_RESPONSE (default 5 s). */
  authTimeoutMs?: number;
  /** Re-check revocation and roles of open connections this often (default 5 s). */
  revocationPollMs?: number;
  /** Abandon one identity-store call after this long; counts as unavailable (default 5 s). */
  identityTimeoutMs?: number;
  /** Close connections whose last successful check is older than this (default 60 s). */
  revocationMaxStaleMs?: number;
  /**
   * Per-connection token bucket over all frames, so a read-only user cannot flood either: an UPDATE costs 1,
   * AWARENESS 4 and SYNC_1 10 (it makes the gateway encode a diff). Defaults: 200 tokens/s, burst 400.
   */
  rateLimitPerSecond?: number;
  rateLimitBurst?: number;
}

export interface GatewayOptions {
  port?: number;
  host?: string;
  engine?: EngineName;
  /**
   * Static key set for tests and the Phase 0 demo. Ignored when `auth` is set. Exactly one of
   * `resolveKey` and `auth` is required.
   */
  resolveKey?: KeyResolver;
  auth?: AuthOptions;
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
  authenticated: number;
  authFailures: Record<string, number>;
  rejected: Record<string, number>;
  evictions: number;
  busyRejections: number;
  catchUpsInFlight: number;
  degraded: boolean;
}

type Resolved = Required<Omit<GatewayOptions, "store" | "objects" | "log" | "engine" | "port" | "host" | "resolveKey" | "auth">>;

type Mode = "full" | "upload_only";
interface Conn {
  readonly ws: WebSocket;
  readonly docId: string;
  phase: "await_auth" | "verifying" | "loading" | "ready" | "closed";
  readonly backlog: Uint8Array[];
  room: Room | undefined;
  nonce: Uint8Array | undefined;
  authTimer: NodeJS.Timeout | undefined;
  cert: Certificate | undefined;
  role: Role;
  mode: Mode;
  lastCheckedAt: number;
  tokens: number;
  refilledAt: number;
}
const AUTH_CLOSE = { unauthenticated: 4401, forbidden: 4403 } as const;
const MODE_CODE: Record<Mode, number> = { full: 0, upload_only: 1 };
/** Token cost per frame type for the per-connection rate limit; anything else costs 1. */
const COST: Partial<Record<number, number>> = { [FrameType.SYNC_1]: 10, [FrameType.AWARENESS]: 4 };

interface ResolvedAuth {
  trust: ReturnType<typeof trustAnchors>;
  identity: IdentityStore;
  now: () => number;
  graceMs: number;
  maxClockSkewMs: number;
  authTimeoutMs: number;
  revocationPollMs: number;
  revocationMaxStaleMs: number;
  identityTimeoutMs: number;
  rateLimitPerSecond: number;
  rateLimitBurst: number;
}

export class Gateway {
  readonly #engine: SyncEngine;
  readonly #rooms = new Map<string, Room>();
  readonly #store: DocumentStore;
  readonly #objects: ObjectStore;
  readonly #host: string;
  readonly #port: number;
  readonly #o: Resolved;
  readonly #log: Log;
  readonly #auth: ResolvedAuth | undefined;
  readonly #resolveKey: KeyResolver | undefined;
  readonly #conns = new Map<WebSocket, Conn>();
  readonly #stats: RoomStats & {
    accepted: number;
    authenticated: number;
    authFailures: Record<string, number>;
    rejected: Record<string, number>;
    evictions: number;
    busyRejections: number;
  } = {
    persisted: 0,
    duplicates: 0,
    snapshots: 0,
    snapshotFailures: 0,
    snapshotFallbacks: 0,
    poisonUpdates: 0,
    loads: 0,
    accepted: 0,
    authenticated: 0,
    authFailures: {},
    rejected: {},
    evictions: 0,
    busyRejections: 0,
  };
  #connections = 0;
  #polling = false;
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
    if ((opts.resolveKey === undefined) === (opts.auth === undefined)) {
      throw new Error("configure exactly one of `auth` (certificates) or `resolveKey` (static keys)");
    }
    this.#resolveKey = opts.resolveKey;
    const a = opts.auth;
    if (a?.rateLimitBurst !== undefined && a.rateLimitBurst < 10) {
      throw new Error("rateLimitBurst must be at least 10, the cost of one SYNC_1, or no client could ever sync");
    }
    this.#auth = a && {
      trust: trustAnchors(a.issuers),
      identity: a.identity,
      now: a.now ?? Date.now,
      graceMs: a.graceMs ?? 72 * 3_600_000,
      maxClockSkewMs: a.maxClockSkewMs ?? 5 * 60_000,
      authTimeoutMs: a.authTimeoutMs ?? 5000,
      revocationPollMs: a.revocationPollMs ?? 5000,
      revocationMaxStaleMs: a.revocationMaxStaleMs ?? 60_000,
      identityTimeoutMs: a.identityTimeoutMs ?? 5000,
      rateLimitPerSecond: a.rateLimitPerSecond ?? 200,
      rateLimitBurst: a.rateLimitBurst ?? 400,
    };
    this.#o = {
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
      authFailures: { ...this.#stats.authFailures },
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
    if (this.#auth) this.#timers.push(setInterval(() => void this.reauthorize(), this.#auth.revocationPollMs).unref());
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
        now: this.#auth?.now ?? Date.now,
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
    const now = this.#auth?.now() ?? Date.now();
    const conn: Conn = {
      ws,
      docId,
      phase: this.#auth ? "await_auth" : "loading",
      backlog: [],
      room: undefined,
      nonce: undefined,
      authTimer: undefined,
      cert: undefined,
      role: "admin", // static-key mode has no roles: signature validity is the only check
      mode: "full",
      lastCheckedAt: now,
      tokens: this.#auth?.rateLimitBurst ?? 0,
      refilledAt: now,
    };
    this.#conns.set(ws, conn);
    this.#connections++;
    (ws as WebSocket & { alive?: boolean }).alive = true;
    ws.on("pong", () => ((ws as WebSocket & { alive?: boolean }).alive = true));

    ws.on("message", (data, isBinary) => {
      // A socket we have closed can keep delivering frames until the peer answers the close handshake.
      if (conn.phase === "closed") return;
      if (!isBinary) {
        if (conn.phase === "await_auth") return this.#authFail(conn, "malformed");
        return this.#reject(ws, "text_frame");
      }
      const bytes = toBytes(data);
      if (conn.phase === "ready") return this.#onMessage(conn, bytes);
      if (conn.phase === "await_auth") return this.#firstFrame(conn, bytes);
      // verifying or loading: keep order, bounded.
      if (conn.backlog.length < MAX_LOAD_BACKLOG) conn.backlog.push(bytes);
      else this.#shut(conn, 1013, "too many messages while loading");
    });
    ws.on("close", () => {
      clearTimeout(conn.authTimer);
      this.#conns.delete(ws);
      this.#connections--;
      const room = conn.room;
      if (room) {
        room.clients.delete(ws);
        if (room.clients.size === 0) room.idleSince = Date.now();
      }
    });
    ws.on("error", () => ws.terminate());

    if (this.#auth) {
      // No room is touched until the peer has authenticated: strangers cannot make us load documents.
      conn.nonce = newNonce();
      ws.send(encodeFrame({ type: FrameType.AUTH_CHALLENGE, flags: 0, sessionId: 0, seq: 0, claimedAtMs: now, payload: conn.nonce }));
      conn.authTimer = setTimeout(() => {
        if (conn.phase === "await_auth") this.#authFail(conn, "timeout");
      }, this.#auth.authTimeoutMs);
    } else {
      this.#attach(conn);
    }
  }

  /** Joins the document's room and starts processing frames once it has loaded. */
  #attach(conn: Conn): void {
    const room = this.#room(conn.docId);
    conn.room = room;
    conn.phase = "loading";
    room.clients.add(conn.ws);
    room.idleSince = undefined;
    room.ready.then(
      () => {
        if (this.#conns.get(conn.ws) !== conn || conn.phase !== "loading") return;
        conn.phase = "ready";
        for (const bytes of conn.backlog.splice(0)) this.#onMessage(conn, bytes);
      },
      () => this.#shut(conn, 1013, "document unavailable"),
    );
  }

  // ----- authentication ------------------------------------------------------

  #firstFrame(conn: Conn, bytes: Uint8Array): void {
    let frame: Frame;
    try {
      frame = decodeFrame(bytes, { maxPayloadBytes: 4096 });
    } catch {
      return this.#authFail(conn, "malformed");
    }
    if (frame.type !== FrameType.AUTH_RESPONSE) return this.#authFail(conn, "unauthenticated");
    conn.phase = "verifying";
    void this.#authenticate(conn, frame.payload);
  }

  async #authenticate(conn: Conn, payload: Uint8Array): Promise<void> {
    const auth = this.#auth as ResolvedAuth;
    const v = verifyAuthResponse(payload, conn.docId, conn.nonce as Uint8Array, auth.trust);
    if (!v.ok) return this.#authFail(conn, v.reason);
    const cert = v.certificate;
    const now = auth.now();
    if (now < cert.notBeforeMs - auth.maxClockSkewMs) return this.#authFail(conn, "not_yet_valid");
    if (now > cert.notAfterMs + auth.graceMs) return this.#authFail(conn, "expired");

    let answer;
    try {
      [answer] = await this.#authorize([{ serial: cert.serial, principalId: cert.subject, documentId: conn.docId }]);
    } catch {
      return this.#authFail(conn, "unavailable"); // fail closed
    }
    if (conn.phase !== "verifying") return; // closed while we were waiting
    if (!answer || !answer.ok) {
      const reason = answer?.reason;
      return this.#authFail(conn, reason === "no_access" ? "no_access" : reason === "unknown_certificate" ? "bad_certificate" : "revoked");
    }
    clearTimeout(conn.authTimer);
    conn.cert = cert;
    conn.role = answer.role;
    conn.mode = now <= cert.notAfterMs ? "full" : "upload_only";
    conn.lastCheckedAt = now;
    this.#stats.authenticated++;
    this.#log("auth_ok", { docId: conn.docId, principal: cert.subject, serial: serialHex(cert.serial), role: conn.role, mode: conn.mode });
    this.#sendAuthResult(conn);
    this.#attach(conn);
  }

  #sendAuthResult(conn: Conn): void {
    send(conn.ws, {
      type: FrameType.AUTH_RESULT,
      flags: 0,
      sessionId: 0,
      seq: 0,
      payload: Uint8Array.of(ROLES.indexOf(conn.role), MODE_CODE[conn.mode]),
    });
  }

  #authFail(conn: Conn, reason: string): void {
    this.#stats.authFailures[reason] = (this.#stats.authFailures[reason] ?? 0) + 1;
    this.#log("auth_failed", { docId: conn.docId, reason });
    send(conn.ws, { type: FrameType.ERROR, flags: 0, sessionId: 0, seq: 0, payload: new TextEncoder().encode(`auth_failed;${reason}`) });
    this.#shut(conn, reason === "no_access" ? AUTH_CLOSE.forbidden : reason === "unavailable" ? 1013 : AUTH_CLOSE.unauthenticated, reason);
  }

  /** Closes a connection and stops processing anything it still sends while the close handshake finishes. */
  #shut(conn: Conn, code: number, reason: string): void {
    clearTimeout(conn.authTimer);
    conn.phase = "closed";
    conn.backlog.length = 0;
    conn.ws.close(code, reason);
  }

  /** One identity-store call, abandoned if it hangs: a stalled database must read as "unavailable", not as "fine". */
  #authorize(queries: Parameters<IdentityStore["authorize"]>[0]): ReturnType<IdentityStore["authorize"]> {
    const auth = this.#auth as ResolvedAuth;
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("identity store timed out")), auth.identityTimeoutMs);
    });
    return Promise.race([auth.identity.authorize(queries), timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Re-checks every authenticated connection against the identity store: revoked certificate,
   * disabled principal, lost or changed role, expiry. Runs on a timer; exposed so tests are deterministic.
   */
  async reauthorize(): Promise<void> {
    const auth = this.#auth;
    if (!auth || this.#polling) return; // never overlap: a slow database must not pile up polls
    this.#polling = true;
    try {
      const now = auth.now();
      const live = [...this.#conns.values()].filter((c) => c.cert !== undefined && c.phase !== "await_auth" && c.phase !== "closed");
      for (const c of live) {
        if (!this.#refreshMode(c, now)) continue;
        // Staleness is enforced here, before asking: it holds whether the query fails, hangs or never returns.
        if (now - c.lastCheckedAt > auth.revocationMaxStaleMs) this.#shut(c, 1013, "identity unavailable");
      }
      const survivors = live.filter((c) => c.phase !== "closed");
      for (let i = 0; i < survivors.length; i += 500) {
        const chunk = survivors.slice(i, i + 500);
        let answers;
        try {
          answers = await this.#authorize(
            chunk.map((c) => ({ serial: (c.cert as Certificate).serial, principalId: (c.cert as Certificate).subject, documentId: c.docId })),
          );
        } catch {
          continue; // keep serving the last known role until the stale window runs out
        }
        chunk.forEach((c, k) => {
          const a = answers[k];
          if (!a || c.phase === "closed") return;
          c.lastCheckedAt = now;
          if (!a.ok) {
            this.#log("auth_revoked", { docId: c.docId, reason: a.reason });
            this.#shut(c, a.reason === "no_access" ? AUTH_CLOSE.forbidden : AUTH_CLOSE.unauthenticated, a.reason === "no_access" ? "no_access" : "revoked");
          } else if (a.role !== c.role) {
            c.role = a.role;
            this.#sendAuthResult(c);
          }
        });
      }
    } finally {
      this.#polling = false;
    }
  }

  /** Applies expiry to one connection: full until notAfter, upload-only through grace, then closed. */
  #refreshMode(conn: Conn, now: number): boolean {
    const auth = this.#auth;
    const cert = conn.cert;
    if (!auth || !cert) return true;
    if (now > cert.notAfterMs + auth.graceMs) {
      this.#shut(conn, AUTH_CLOSE.unauthenticated, "expired");
      return false;
    }
    if (now > cert.notAfterMs && conn.mode === "full") {
      conn.mode = "upload_only";
      this.#sendAuthResult(conn);
    }
    return true;
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

  /** Sends to every peer that may read: authenticated, not upload-only, and not the sender. */
  #relay(room: Room, from: WebSocket, bytes: Uint8Array): void {
    const now = this.#auth?.now() ?? 0;
    for (const peer of room.clients) {
      if (peer === from || peer.readyState !== peer.OPEN) continue;
      const pc = this.#conns.get(peer);
      // Expiry is applied at the moment of delivery, not at the next poll.
      if (pc && (pc.phase === "closed" || !this.#refreshMode(pc, now) || pc.mode === "upload_only")) continue;
      peer.send(bytes);
    }
  }

  #onMessage(conn: Conn, bytes: Uint8Array): void {
    const { ws } = conn;
    const room = conn.room as Room;
    let frame: Frame;
    try {
      frame = decodeFrame(bytes, { maxPayloadBytes: this.#o.maxPayloadBytes });
    } catch {
      if (this.#auth && conn.cert && this.#take(conn, 1) > 0) return; // junk floods are dropped silently
      return this.#reject(ws, "malformed");
    }
    if (this.#auth && !this.#refreshMode(conn, this.#auth.now())) return;
    if (this.#auth && conn.cert) {
      const wait = this.#take(conn, COST[frame.type] ?? 1);
      if (wait > 0) return this.#reject(ws, `rate_limited;retry_after_ms=${wait}`, frame.seq);
    }

    switch (frame.type) {
      case FrameType.SYNC_1:
        if (conn.mode === "upload_only") return this.#reject(ws, "upload_only");
        return this.#catchUp(ws, room, frame);
      case FrameType.UPDATE:
        return this.#update(conn, room, bytes, frame.seq);
      case FrameType.AWARENESS:
        if (conn.mode === "upload_only") return this.#reject(ws, "upload_only");
        // Presence is relayed, never stored or applied, and capped so it cannot be used to flood peers.
        if (frame.payload.length > this.#o.maxAwarenessBytes) return this.#reject(ws, "awareness_too_large");
        return this.#relay(room, ws, bytes);
      default:
        return this.#reject(ws, "type_not_allowed");
    }
  }

  /** Takes `cost` tokens from the connection's bucket. Returns 0 on success, else the ms to wait. */
  #take(conn: Conn, cost: number): number {
    const auth = this.#auth as ResolvedAuth;
    const now = auth.now();
    // A clock that steps backwards must not drain the bucket.
    const elapsed = Math.max(0, now - conn.refilledAt);
    conn.tokens = Math.min(auth.rateLimitBurst, conn.tokens + (elapsed / 1000) * auth.rateLimitPerSecond);
    conn.refilledAt = Math.max(conn.refilledAt, now);
    if (conn.tokens < cost) return Math.ceil(((cost - conn.tokens) / auth.rateLimitPerSecond) * 1000);
    conn.tokens -= cost;
    return 0;
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

  #update(conn: Conn, room: Room, bytes: Uint8Array, seq: number): void {
    const { ws } = conn;
    const auth = this.#auth;
    const cert = conn.cert;
    if (auth && cert) {
      if (!roleAtLeast(conn.role, "write")) return this.#reject(ws, "forbidden", seq);
    }
    const resolve: KeyResolver = cert
      ? (keyId) => (keyIdMatches(keyId, cert.publicKey) ? cert.publicKey : undefined)
      : (this.#resolveKey as KeyResolver);
    const result = verifyUpdate(bytes, conn.docId, resolve, { maxPayloadBytes: this.#o.maxPayloadBytes });
    if (!result.ok) return this.#reject(ws, result.reason);
    const { frame } = result;
    if (auth && cert) {
      // The signer asserts when the edit was made. It must fall inside the certificate's life and not be from the future.
      const now = auth.now();
      const t = frame.claimedAtMs;
      if (t < cert.notBeforeMs) return this.#reject(ws, "claimed_before_validity", frame.seq);
      if (t > cert.notAfterMs) return this.#reject(ws, "claimed_after_expiry", frame.seq);
      if (t > now + auth.maxClockSkewMs) return this.#reject(ws, "claimed_in_future", frame.seq);
    }
    room.submit({
      frame,
      bytes,
      ...(cert ? { certSerial: cert.serial } : {}),
      accepted: (_seq, fresh) => {
        if (fresh) {
          this.#stats.accepted++;
          this.#relay(room, ws, bytes);
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

function keyIdMatches(keyId: Uint8Array, publicKey: Uint8Array): boolean {
  return Buffer.from(keyIdOf(publicKey)).equals(keyId);
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
