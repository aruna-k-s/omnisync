import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FsObjectStore,
  MemoryDocumentStore,
  MemoryIdentityStore,
  PgIdentityStore,
  MemoryObjectStore,
  PgDocumentStore,
  StoreUnavailableError,
  migrate,
  snapshotObjectKey,
} from "../src/index.js";
import { FaultyDocumentStore } from "../src/testing.js";
import { checkpoint, documentStoreContract, upd } from "./contract.js";
import { identityStoreContract } from "./identity-contract.js";
import { objectStoreContract } from "./object-contract.js";

documentStoreContract("memory", async () => new MemoryDocumentStore());
identityStoreContract("memory", async () => new MemoryIdentityStore());
objectStoreContract("memory", async () => new MemoryObjectStore());
objectStoreContract("filesystem", async () => new FsObjectStore(await mkdtemp(join(tmpdir(), "omnisync-fs-contract-"))));

describe("object stores", () => {
  const bytes = new Uint8Array([1, 2, 3]);

  it("memory store round-trips and reports missing objects", async () => {
    const o = new MemoryObjectStore();
    await o.put("a/b", bytes);
    expect([...((await o.get("a/b")) ?? [])]).toEqual([1, 2, 3]);
    expect(await o.get("nope")).toBeUndefined();
    await o.delete("a/b");
    expect(await o.get("a/b")).toBeUndefined();
  });

  it("filesystem store round-trips, overwrites atomically and refuses path escapes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnisync-fs-"));
    try {
      const o = new FsObjectStore(dir);
      await o.put("snapshots/x/1.bin", bytes);
      await o.put("snapshots/x/1.bin", new Uint8Array([9]));
      expect([...((await o.get("snapshots/x/1.bin")) ?? [])]).toEqual([9]);
      expect(await o.get("snapshots/x/missing.bin")).toBeUndefined();
      await expect(o.put("../escape", bytes)).rejects.toThrow(/escapes root/);
      await o.delete("snapshots/x/1.bin");
      expect(await o.get("snapshots/x/1.bin")).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("snapshot keys are stable, content-addressed and path-safe", () => {
    const k = snapshotObjectKey("../../evil/doc", 42, "ab".repeat(32));
    expect(k).toBe(snapshotObjectKey("../../evil/doc", 42, "ab".repeat(32)));
    expect(k).not.toContain("..");
    expect(k).toMatch(/^snapshots\/[0-9a-f]+\/000000000042-abababababababab\.bin$/);
  });
});

describe("FaultyDocumentStore", () => {
  it("fails on demand with StoreUnavailableError, then recovers", async () => {
    const f = new FaultyDocumentStore(new MemoryDocumentStore());
    f.failNext = 1;
    await expect(f.appendUpdates("d", [upd(1)])).rejects.toBeInstanceOf(StoreUnavailableError);
    await expect(f.appendUpdates("d", [upd(1)])).resolves.toHaveLength(1);
    f.down = true;
    await expect(f.ping()).rejects.toBeInstanceOf(StoreUnavailableError);
  });
});

const url = process.env.OMNISYNC_TEST_DATABASE_URL;

describe.skipIf(!url)("PostgreSQL store", () => {
  const schema = `t_${randomBytes(5).toString("hex")}`;
  let admin: pg.Pool;
  const stores: PgDocumentStore[] = [];
  const open = () => {
    const s = new PgDocumentStore({ connectionString: url as string, schema });
    stores.push(s);
    return s;
  };

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url as string });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const s = open();
    await migrate(s.pool);
  });

  afterAll(async () => {
    await Promise.all(stores.map((s) => s.close().catch(() => {})));
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  let n = 0;
  documentStoreContract("postgres", async () => {
    // Fresh document ids are not enough: contract tests use fixed ids, so use a fresh schema each time.
    const s = `${schema}_c${n++}`;
    await admin.query(`CREATE SCHEMA ${s}`);
    const store = new PgDocumentStore({ connectionString: url as string, schema: s });
    stores.push(store);
    await migrate(store.pool);
    const close = store.close.bind(store);
    store.close = async () => {
      await close();
      await admin.query(`DROP SCHEMA ${s} CASCADE`);
    };
    return store;
  });

  let m = 0;
  identityStoreContract("postgres", async () => {
    const s = `${schema}_i${m++}`;
    await admin.query(`CREATE SCHEMA ${s}`);
    const docs = new PgDocumentStore({ connectionString: url as string, schema: s });
    stores.push(docs);
    await migrate(docs.pool);
    const store = new PgIdentityStore(docs.pool);
    store.close = async () => {
      await docs.close();
      await admin.query(`DROP SCHEMA ${s} CASCADE`);
    };
    return store;
  });

  it("checkpoints are append-only in the database, and concurrent reservations of one n yield one winner", async () => {
    const docs = open();
    await docs.appendUpdates("cp-race", [upd(1)]);
    const heads = await docs.pendingHeads(100);
    // Four writers sign different checkpoints for the same n (different times), all valid on their own.
    const cps = await Promise.all([1, 2, 3, 4].map((i) => checkpoint(1, new Uint8Array(32), heads, 1_800_000_000_000 + i)));
    const writers = [open(), open(), open(), open()];
    const results = await Promise.all(writers.map((w, i) => w.reserveCheckpoint(cps[i] as (typeof cps)[number])));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await docs.listCheckpoints(0, 10)).length).toBe(1);
    await expect(docs.pool.query("UPDATE ledger_checkpoints SET bytes = '\\x00'")).rejects.toThrow(/append-only/);
    await expect(docs.pool.query("DELETE FROM ledger_checkpoints")).rejects.toThrow(/append-only/);
  });

  it("document order is UTF-8 byte order even in a database whose collation sorts differently", async (ctx) => {
    const name = `icu_${randomBytes(4).toString("hex")}`;
    try {
      await admin.query(`CREATE DATABASE ${name} LOCALE_PROVIDER icu ICU_LOCALE 'en-US' LOCALE 'C' ENCODING 'UTF8' TEMPLATE template0`);
    } catch {
      return ctx.skip(); // this server was built without ICU
    }
    const u = new URL(url as string);
    u.pathname = `/${name}`;
    const store = new PgDocumentStore({ connectionString: u.toString() });
    try {
      await migrate(store.pool);
      const ids = ["b", "a", "B", "ä", "a1"];
      // Sanity: the default collation really does disagree with byte order here.
      const dflt = await store.pool.query<{ r: string }>("SELECT string_agg(x, ',' ORDER BY x) AS r FROM unnest($1::text[]) x", [ids]);
      expect(dflt.rows[0]?.r).not.toBe("B,a,a1,b,ä");
      for (const id of ids) await store.appendUpdates(id, [upd(1)]);
      expect((await store.pendingHeads(10)).map((h) => h.documentId)).toEqual(["B", "a", "a1", "b", "ä"]);
      expect(await store.listDocuments(undefined, 10)).toEqual(["B", "a", "a1", "b", "ä"]);
      expect(await store.listDocuments("a", 10)).toEqual(["a1", "b", "ä"]);
    } finally {
      await store.close();
      await admin.query(`DROP DATABASE ${name}`);
    }
  });

  it("the database refuses a checkpoint position beyond the log", async () => {
    const docs = open();
    await docs.appendUpdates("cp-bound", [upd(1)]);
    await expect(docs.pool.query("UPDATE documents SET checkpoint_seq = 5 WHERE id = 'cp-bound'")).rejects.toThrow(/checkpoint_within_head/);
  });

  it("migration 003 refuses to chain pre-ledger rows", async () => {
    const s = `${schema}_m3`;
    await admin.query(`CREATE SCHEMA ${s}`);
    const pool = new pg.Pool({ connectionString: url as string, options: `-c search_path=${s}` });
    try {
      // Apply 001 and 002 by hand, add a row the way week 4 wrote it, then run the real migrator.
      const { readFile } = await import("node:fs/promises");
      for (const f of ["001_init.sql", "002_identity.sql"]) {
        const path = new URL(`../migrations/${f}`, import.meta.url);
        await pool.query(await readFile(path, "utf8"));
      }
      await pool.query("CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      await pool.query("INSERT INTO schema_migrations (name) VALUES ('001_init.sql'), ('002_identity.sql')");
      await pool.query("INSERT INTO documents (id) VALUES ('old')");
      await pool.query("INSERT INTO document_updates (document_id, seq, key_id, session_id, client_seq, frame) VALUES ('old', 1, '\\x01', 1, 1, '\\x02')");
      await expect(migrate(pool)).rejects.toThrow(/cannot chain rows written before the ledger/);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${s} CASCADE`);
    }
  });

  it("the audit trail is append-only in the database itself", async () => {
    const docs = open();
    const ids = new PgIdentityStore(docs.pool);
    await ids.upsertPrincipal(
      { oidcIssuer: "i", oidcSubject: "s", email: "e", displayName: "d", orgRole: "member" },
      { atMs: 1, actor: "system", action: "auth.login", target: "" },
    );
    await expect(docs.pool.query("UPDATE audit_events SET actor = 'x'")).rejects.toThrow(/append-only/);
    await expect(docs.pool.query("DELETE FROM audit_events")).rejects.toThrow(/append-only/);
    expect(await ids.listAudit(0, 10)).toHaveLength(1);
  });


  it("migrate is idempotent and safe to run concurrently", async () => {
    const a = open();
    const b = open();
    expect(await migrate(a.pool)).toEqual([]);
    expect(await Promise.all([migrate(a.pool), migrate(b.pool)])).toEqual([[], []]);
  });

  it("the log is append-only: UPDATE and DELETE are rejected by the database", async () => {
    const s = open();
    await s.appendUpdates("immutable", [upd(1)]);
    await expect(s.pool.query("UPDATE document_updates SET frame = '\\x00' WHERE document_id = 'immutable'")).rejects.toThrow(
      /append-only/,
    );
    await expect(s.pool.query("DELETE FROM document_updates WHERE document_id = 'immutable'")).rejects.toThrow(/append-only/);
    expect((await s.readUpdates("immutable", 0, 10)).length).toBe(1);
  });

  it("concurrent writers to one document get unique gapless seqs", async () => {
    const a = open();
    const b = open();
    const batches = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? a : b).appendUpdates("race", [upd(1, { session: i + 1 }), upd(2, { session: i + 1 })]),
      ),
    );
    const seqs = batches.flat().map((r) => (r.status === "appended" ? r.seq : -1));
    expect([...seqs].sort((x, y) => x - y)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(await a.headSeq("race")).toBe(40);
    const rows = await b.readUpdates("race", 0, 100);
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it("data and replay protection survive a store restart", async () => {
    const first = open();
    await first.appendUpdates("restart", [upd(1), upd(2)]);
    await first.close();
    const second = open();
    expect((await second.readUpdates("restart", 0, 10)).length).toBe(2);
    const r = await second.appendUpdates("restart", [upd(2), upd(3)]);
    expect(r.map((x) => x.status)).toEqual(["duplicate", "appended"]);
    expect(await second.headSeq("restart")).toBe(3);
  });

  it("a failed batch leaves nothing behind", async () => {
    const s = open();
    // 1e19 overflows bigint, so Postgres rejects the second entry after the first was inserted.
    const poison = { ...upd(2), sessionId: 1e19 };
    await expect(s.appendUpdates("atomic", [upd(1), poison])).rejects.toBeInstanceOf(StoreUnavailableError);
    expect(await s.headSeq("atomic")).toBe(0);
    expect(await s.readUpdates("atomic", 0, 10)).toEqual([]);
    expect((await s.appendUpdates("atomic", [upd(1)]))[0]).toMatchObject({ status: "appended", seq: 1 });
  });

  it("reports StoreUnavailableError when the database is unreachable", async () => {
    const dead = new PgDocumentStore({ connectionString: "postgres://nobody@127.0.0.1:1/none", connectionTimeoutMs: 500 });
    await expect(dead.ping()).rejects.toBeInstanceOf(StoreUnavailableError);
    await expect(dead.appendUpdates("d", [upd(1)])).rejects.toBeInstanceOf(StoreUnavailableError);
    await dead.close();
  });
});
