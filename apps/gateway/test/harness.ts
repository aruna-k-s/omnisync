import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { EngineName } from "@omnisync/engine";
import { Keyring, generateKeyPair, type KeyPair } from "@omnisync/protocol";
import {
  FsObjectStore,
  MemoryDocumentStore,
  MemoryObjectStore,
  PgDocumentStore,
  migrate,
  type DocumentStore,
  type ObjectStore,
} from "@omnisync/store";
import { FaultyDocumentStore, FaultyObjectStore } from "@omnisync/store/testing";
import { Gateway, GatewayClient, type GatewayOptions } from "../src/index.js";

export const PG_URL = process.env.OMNISYNC_TEST_DATABASE_URL;

export const keys: KeyPair[] = Array.from({ length: 8 }, (_, i) => generateKeyPair(new Uint8Array(32).fill(i + 1)));
export const ring = new Keyring();
for (const k of keys) ring.add(k.publicKey);

export const until = async (cond: () => boolean, ms = 5000, what = "condition") => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type StoreKind = "memory" | "postgres";

export interface World {
  kind: StoreKind;
  store: FaultyDocumentStore;
  objects: FaultyObjectStore;
  /** Raw inner object store, to inspect or delete snapshots behind the gateway's back. */
  rawObjects: ObjectStore;
  rawStore: DocumentStore;
  cleanup(): Promise<void>;
}

/** One isolated database + object store. Survives gateway restarts inside a test, like production would. */
export async function makeWorld(kind: StoreKind): Promise<World> {
  if (kind === "memory") {
    const rawStore = new MemoryDocumentStore();
    const rawObjects = new MemoryObjectStore();
    return {
      kind,
      store: new FaultyDocumentStore(rawStore),
      objects: new FaultyObjectStore(rawObjects),
      rawStore,
      rawObjects,
      cleanup: async () => {},
    };
  }
  const schema = `g_${randomBytes(5).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: PG_URL as string });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const rawStore = new PgDocumentStore({ connectionString: PG_URL as string, schema });
  await migrate(rawStore.pool);
  const dir = await mkdtemp(join(tmpdir(), "omnisync-gw-"));
  const rawObjects = new FsObjectStore(dir);
  return {
    kind,
    store: new FaultyDocumentStore(rawStore),
    objects: new FaultyObjectStore(rawObjects),
    rawStore,
    rawObjects,
    cleanup: async () => {
      await rawStore.close().catch(() => {});
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export interface Running {
  gateway: Gateway;
  url: string;
  port: number;
}

export async function startGateway(world: World, opts: Partial<GatewayOptions> = {}): Promise<Running> {
  const gateway = new Gateway({ resolveKey: ring.resolve, store: world.store, objects: world.objects, sweepMs: 3_600_000, ...opts });
  const port = await gateway.listen();
  return { gateway, url: `ws://127.0.0.1:${port}`, port };
}

export async function connectClient(
  url: string,
  actor: number,
  engine: EngineName = "yjs",
  extra: { docId?: string; reconnect?: boolean; baseMs?: number; maxMs?: number; random?: () => number } = {},
): Promise<GatewayClient> {
  return GatewayClient.connect({
    url,
    docId: extra.docId ?? "doc",
    actor,
    key: keys[actor % keys.length] as KeyPair,
    engine,
    reconnect: extra.reconnect ?? false,
    backoff: { baseMs: extra.baseMs ?? 10, maxMs: extra.maxMs ?? 200 },
    ...(extra.random ? { random: extra.random } : {}),
  });
}
