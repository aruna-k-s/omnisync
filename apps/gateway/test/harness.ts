import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { EngineName } from "@omnisync/engine";
import { issueCertificate, signerFromKeyPair } from "@omnisync/crypto";
import { Keyring, generateKeyPair, type KeyPair } from "@omnisync/protocol";
import {
  FsObjectStore,
  MemoryDocumentStore,
  MemoryIdentityStore,
  MemoryObjectStore,
  PgDocumentStore,
  PgIdentityStore,
  type IdentityStore,
  type Principal,
  type Role,
  migrate,
  type DocumentStore,
  type ObjectStore,
} from "@omnisync/store";
import { FaultyDocumentStore, FaultyIdentityStore, FaultyObjectStore } from "@omnisync/store/testing";
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
  /** Identity store with fault injection, sharing the database with the update log. */
  identity: FaultyIdentityStore;
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
      identity: new FaultyIdentityStore(new MemoryIdentityStore()),
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
    identity: new FaultyIdentityStore(new PgIdentityStore(rawStore.pool)),
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
  const gateway = new Gateway({ ...(opts.auth ? {} : { resolveKey: ring.resolve }), store: world.store, objects: world.objects, sweepMs: 3_600_000, ...opts });
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

// ----- identity helpers ---------------------------------------------------------

export const issuerKey = generateKeyPair(new Uint8Array(32).fill(200));
export const ledgerKey = generateKeyPair(new Uint8Array(32).fill(201));
export const T0 = 1_800_000_000_000;
export const HOUR = 3_600_000;

/** A controllable clock shared by the gateway and the clients under test. */
export class TestClock {
  constructor(public t = T0) {}
  readonly now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface Enrolled {
  principal: Principal;
  key: KeyPair;
  certificate: Uint8Array;
  serial: Uint8Array;
}

/** Creates people, certificates and grants directly in the identity store, as the control plane would. */
export class TestIdentity {
  #n = 0;
  constructor(
    readonly store: IdentityStore,
    readonly clock: TestClock,
  ) {}

  async person(name: string, orgRole: "member" | "admin" = "member"): Promise<Principal> {
    return this.store.upsertPrincipal(
      { oidcIssuer: "https://idp.test", oidcSubject: name, email: `${name}@test`, displayName: name, orgRole },
      { atMs: this.clock.t, actor: "system", action: "auth.login", target: "" },
    );
  }

  async enroll(
    name: string,
    grants: Record<string, Role> = {},
    opts: { lifetimeMs?: number; notBeforeMs?: number; keySeed?: number } = {},
  ): Promise<Enrolled> {
    const principal = await this.person(name);
    const key = generateKeyPair(new Uint8Array(32).fill(opts.keySeed ?? 20 + this.#n++));
    const issuedAtMs = this.clock.t;
    const notBeforeMs = opts.notBeforeMs ?? issuedAtMs;
    const notAfterMs = notBeforeMs + (opts.lifetimeMs ?? 24 * HOUR);
    const serial = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const certificate = issueCertificate(
      { subject: principal.id, subjectPublicKey: key.publicKey, issuedAtMs, notBeforeMs, notAfterMs, serial },
      signerFromKeyPair(issuerKey),
    );
    await this.store.recordCertificate(
      { serial, principalId: principal.id, keyId: key.keyId, publicKey: key.publicKey, issuedAtMs, notBeforeMs, notAfterMs, certificate },
      { atMs: issuedAtMs, actor: "system", action: "cert.issue", target: principal.id },
    );
    for (const [doc, role] of Object.entries(grants)) await this.grant(doc, principal, role);
    return { principal, key, certificate, serial };
  }

  grant(doc: string, p: Principal, role: Role): Promise<void> {
    return this.store.setGrant(doc, p.id, role, "system", this.clock.t, {
      atMs: this.clock.t,
      actor: "system",
      action: "grant.set",
      target: `${doc}:${p.id}`,
    });
  }

  revoke(e: Enrolled, reason = "test"): Promise<boolean> {
    return this.store.revokeCertificate(e.serial, this.clock.t, reason, { atMs: this.clock.t, actor: "system", action: "cert.revoke", target: "" });
  }
}

export function connectAs(
  url: string,
  e: Enrolled,
  clock: TestClock,
  extra: { docId?: string; reconnect?: boolean; engine?: EngineName; baseMs?: number } = {},
): Promise<GatewayClient> {
  return GatewayClient.connect({
    url,
    docId: extra.docId ?? "doc",
    actor: 1 + (e.key.keyId[0] ?? 0),
    key: e.key,
    certificate: e.certificate,
    engine: extra.engine ?? "yjs",
    reconnect: extra.reconnect ?? false,
    backoff: { baseMs: extra.baseMs ?? 10, maxMs: 200 },
    clock: clock.now,
  });
}
