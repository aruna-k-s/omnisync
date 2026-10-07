import type { SyncEngine } from "@omnisync/engine";
import { yjsEngine } from "@omnisync/engine/yjs";
import { bytesToHex } from "@omnisync/protocol";
import { SyncDocument, type DocumentOptions } from "./document.js";
import type { DeviceKey } from "./keys.js";
import { IndexedDbOutbox, MemoryOutbox, type Outbox } from "./outbox.js";

export interface ClientOptions {
  /** Gateway base URL, e.g. `wss://sync.example.com`. */
  url: string;
  key: DeviceKey;
  certificate?: Uint8Array;
  /** Where each document's outbox lives. Defaults to IndexedDB, or memory (with a warning) where it is unavailable. */
  outbox?: (docId: string) => Outbox | Promise<Outbox>;
  /** Defaults to Yjs. Pass `automergeEngine` or `loroEngine` from `@omnisync/engine` to use another. */
  engine?: SyncEngine;
  tuning?: Partial<Omit<DocumentOptions, "url" | "docId" | "key" | "certificate" | "outbox" | "engine">>;
}

/** One device on one gateway. Opens documents; a certificate renewal reaches all of them. */
export class OmniSyncClient {
  /** Human-readable problems worth showing, such as "no durable storage: edits survive a reconnect but not a reload". */
  readonly warnings: string[] = [];
  readonly #o: ClientOptions;
  readonly #open = new Map<string, SyncDocument>();
  #cert: Uint8Array | undefined;

  constructor(opts: ClientOptions) {
    this.#o = opts;
    this.#cert = opts.certificate;
  }

  get extractable(): boolean {
    return this.#o.key.extractable;
  }

  async open(docId: string, opts: { engine?: SyncEngine } = {}): Promise<SyncDocument> {
    const existing = this.#open.get(docId);
    if (existing) return existing;
    const outbox = await this.#outboxFor(docId);
    const doc = await SyncDocument.open({
      ...this.#o.tuning,
      url: this.#o.url,
      docId,
      key: this.#o.key,
      ...(this.#cert ? { certificate: this.#cert } : {}),
      outbox,
      engine: opts.engine ?? this.#o.engine ?? yjsEngine,
    });
    this.#open.set(docId, doc);
    doc.onStatus((s) => {
      if (s.state === "closed" && s.reason === "closed by the application") this.#open.delete(docId);
    });
    return doc;
  }

  /** A fresh certificate for the same device key: every open document reconnects with it, queued edits intact. */
  setCertificate(certificate: Uint8Array): void {
    this.#cert = certificate;
    for (const d of this.#open.values()) d.setCertificate(certificate);
  }

  async close(): Promise<void> {
    await Promise.all([...this.#open.values()].map((d) => d.close()));
    this.#open.clear();
  }

  async #outboxFor(docId: string): Promise<Outbox> {
    if (this.#o.outbox) return this.#o.outbox(docId);
    const name = `omnisync-outbox:${bytesToHex(this.#o.key.keyId)}:${docId}`;
    if (typeof globalThis.indexedDB !== "undefined") {
      const ob = new IndexedDbOutbox({ name });
      try {
        await ob.highestSeq(0); // opens the database: a private window or a blocked store fails here
        return ob;
      } catch {
        /* fall through */
      }
    }
    this.warnings.push("no durable storage here: edits survive a reconnect but not a reload");
    return new MemoryOutbox();
  }
}
