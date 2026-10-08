import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, type KeyPair } from "@omnisync/protocol";
import { GatewayProcess, type StartOptions } from "./gateway-process.js";

/** What a scenario runs against: a database schema of its own (or memory), a snapshot directory, and the means to start a gateway process on them. */
export interface World {
  readonly store: StartOptions["store"];
  readonly objectsDir: string;
  readonly keys: KeyPair[];
  start(opts?: Partial<Omit<StartOptions, "store" | "objectsDir" | "publicKeys" | "engine">> & { engine?: string }): Promise<GatewayProcess>;
  cleanup(): Promise<void>;
}

export async function makeWorld(opts: { databaseUrl?: string | undefined; keys: number; engine: string }): Promise<World> {
  const objectsDir = await mkdtemp(join(tmpdir(), "omnisync-load-"));
  const keys = Array.from({ length: opts.keys }, () => generateKeyPair());
  const processes: GatewayProcess[] = [];
  let admin: { query(sql: string): Promise<unknown>; end(): Promise<void> } | undefined;
  let store: StartOptions["store"] = { kind: "memory" };
  if (opts.databaseUrl) {
    const { default: pg } = await import("pg");
    const schema = `load_${randomBytes(4).toString("hex")}`;
    admin = new pg.Pool({ connectionString: opts.databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    store = { kind: "postgres", url: opts.databaseUrl, schema };
  }
  return {
    store,
    objectsDir,
    keys,
    async start(o = {}) {
      const p = await GatewayProcess.start({ engine: opts.engine, ...o, store, objectsDir, publicKeys: keys.map((k) => Buffer.from(k.publicKey).toString("hex")) });
      processes.push(p);
      return p;
    },
    async cleanup() {
      await Promise.all(processes.map((p) => p.stop().catch(() => p.kill())));
      if (admin && store.kind === "postgres") {
        await admin.query(`DROP SCHEMA ${store.schema} CASCADE`);
        await admin.end();
      }
      await rm(objectsDir, { recursive: true, force: true });
    },
  };
}
