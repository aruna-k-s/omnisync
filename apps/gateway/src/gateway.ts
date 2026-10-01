import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { getEngine, type EngineDoc, type EngineName, type SyncEngine } from "@omnisync/engine";
import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  FrameType,
  bytesToHex,
  decodeFrame,
  encodeFrame,
  verifyUpdate,
  type KeyResolver,
} from "@omnisync/protocol";

/**
 * Phase 0 gateway prototype.
 *
 * Accepts from clients: SYNC_1 (state vector), UPDATE (signed), AWARENESS.
 * Sends to clients:     SYNC_2 (diff), UPDATE (relayed as received), AWARENESS, ACK, ERROR.
 *
 * Clients can never push unsigned bulk state (no client SYNC_2): every change
 * that reaches the document passed signature verification. Persistence,
 * the ledger and certificates are Phase 1; this keeps state in memory.
 */

const SERVER_ACTOR = 0xffff_fffe;
const PATH = /^\/doc\/([A-Za-z0-9._~-]{1,128})$/;

export interface GatewayOptions {
  port?: number;
  host?: string;
  engine?: EngineName;
  resolveKey: KeyResolver;
  maxPayloadBytes?: number;
}

export interface GatewayStats {
  documents: number;
  connections: number;
  accepted: number;
  rejected: Record<string, number>;
}

interface Room {
  readonly doc: EngineDoc;
  readonly clients: Set<WebSocket>;
  /** Highest seq accepted per key id + session, for replay protection. */
  readonly lastSeq: Map<string, number>;
}

export class Gateway {
  readonly #engine: SyncEngine;
  readonly #rooms = new Map<string, Room>();
  readonly #opts: Required<Omit<GatewayOptions, "host" | "port" | "engine">> & { host: string; port: number };
  readonly #stats: GatewayStats = { documents: 0, connections: 0, accepted: 0, rejected: {} };
  #http: Server | undefined;
  #wss: WebSocketServer | undefined;

  constructor(opts: GatewayOptions) {
    this.#engine = getEngine(opts.engine ?? "yjs");
    this.#opts = {
      resolveKey: opts.resolveKey,
      maxPayloadBytes: opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
      host: opts.host ?? "127.0.0.1",
      port: opts.port ?? 0,
    };
  }

  get stats(): GatewayStats {
    return { ...this.#stats, rejected: { ...this.#stats.rejected }, documents: this.#rooms.size };
  }

  /** Current text of a document, for tests and the demo. */
  textOf(docId: string): string | undefined {
    return this.#rooms.get(docId)?.doc.getText();
  }

  async listen(): Promise<number> {
    const http = createServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, engine: this.#engine.name, ...this.stats }));
        return;
      }
      res.writeHead(404).end();
    });
    // Frame overhead is small; allow 4 KiB above the payload cap.
    const wss = new WebSocketServer({ noServer: true, maxPayload: this.#opts.maxPayloadBytes + 4096 });
    http.on("upgrade", (req, socket, head) => {
      const docId = parseDocId(req);
      if (docId === undefined) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.#onConnection(ws, docId));
    });
    this.#http = http;
    this.#wss = wss;
    await new Promise<void>((resolve) => http.listen(this.#opts.port, this.#opts.host, resolve));
    const addr = http.address();
    if (addr === null || typeof addr === "string") throw new Error("gateway failed to bind");
    return addr.port;
  }

  async close(): Promise<void> {
    for (const client of this.#wss?.clients ?? []) client.terminate();
    await new Promise<void>((resolve) => (this.#wss ? this.#wss.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (this.#http ? this.#http.close(() => resolve()) : resolve()));
    for (const room of this.#rooms.values()) room.doc.destroy();
    this.#rooms.clear();
  }

  #room(docId: string): Room {
    let room = this.#rooms.get(docId);
    if (!room) {
      room = { doc: this.#engine.create(SERVER_ACTOR), clients: new Set(), lastSeq: new Map() };
      this.#rooms.set(docId, room);
    }
    return room;
  }

  #onConnection(ws: WebSocket, docId: string): void {
    const room = this.#room(docId);
    room.clients.add(ws);
    this.#stats.connections++;
    ws.binaryType = "nodebuffer";
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return this.#reject(ws, "text_frame");
      this.#onMessage(ws, docId, room, toBytes(data));
    });
    ws.on("close", () => {
      room.clients.delete(ws);
      this.#stats.connections--;
    });
    ws.on("error", () => ws.terminate());
  }

  #onMessage(ws: WebSocket, docId: string, room: Room, bytes: Uint8Array): void {
    let type: number;
    try {
      type = decodeFrame(bytes, { maxPayloadBytes: this.#opts.maxPayloadBytes }).type;
    } catch {
      return this.#reject(ws, "malformed");
    }

    switch (type) {
      case FrameType.SYNC_1: {
        const { payload } = decodeFrame(bytes);
        let diff: Uint8Array;
        try {
          diff = room.doc.encodeDiff(payload);
        } catch {
          return this.#reject(ws, "bad_state_vector");
        }
        send(ws, { type: FrameType.SYNC_2, flags: 0, sessionId: 0, seq: 0, payload: diff });
        return;
      }
      case FrameType.UPDATE: {
        const result = verifyUpdate(bytes, docId, this.#opts.resolveKey, { maxPayloadBytes: this.#opts.maxPayloadBytes });
        if (!result.ok) return this.#reject(ws, result.reason);
        const { frame } = result;
        const replayKey = `${bytesToHex(frame.keyId as Uint8Array)}:${frame.sessionId}`;
        const last = room.lastSeq.get(replayKey);
        if (last !== undefined && frame.seq <= last) return this.#reject(ws, "replay", frame.seq);
        try {
          room.doc.applyUpdate(frame.payload);
        } catch {
          return this.#reject(ws, "engine_rejected", frame.seq);
        }
        room.lastSeq.set(replayKey, frame.seq);
        this.#stats.accepted++;
        for (const peer of room.clients) if (peer !== ws && peer.readyState === peer.OPEN) peer.send(bytes);
        send(ws, { type: FrameType.ACK, flags: 0, sessionId: frame.sessionId, seq: frame.seq, payload: new Uint8Array() });
        return;
      }
      case FrameType.AWARENESS: {
        // Presence is relayed, never stored or applied.
        for (const peer of room.clients) if (peer !== ws && peer.readyState === peer.OPEN) peer.send(bytes);
        return;
      }
      default:
        return this.#reject(ws, "type_not_allowed");
    }
  }

  #reject(ws: WebSocket, reason: string, seq = 0): void {
    this.#stats.rejected[reason] = (this.#stats.rejected[reason] ?? 0) + 1;
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
