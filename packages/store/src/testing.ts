import type {
  AuditEvent,
  AuditInput,
  AuthorizeQuery,
  AuthorizeResult,
  CertificateRecord,
  Grant,
  GrantGuard,
  IdentityStore,
  Principal,
  Role,
} from "./identity.js";
import {
  StoreUnavailableError,
  type AppendResult,
  type DocumentStore,
  type NewSnapshot,
  type NewUpdate,
  type ObjectStore,
  type SnapshotMeta,
  type StoredUpdate,
} from "./types.js";

/**
 * Fault injection for tests and chaos drills: wraps a real store and makes
 * calls fail on demand, like a database that is down or an object store that
 * is timing out.
 */
export class FaultyDocumentStore implements DocumentStore {
  /** While true every call fails. */
  down = false;
  /** Fail the next N calls, then recover. */
  failNext = 0;
  /** Added latency per call (ms). */
  delayMs = 0;
  calls = 0;

  constructor(readonly inner: DocumentStore) {}

  async #gate(): Promise<void> {
    this.calls++;
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.down || this.failNext > 0) {
      if (this.failNext > 0) this.failNext--;
      throw new StoreUnavailableError("injected fault");
    }
  }

  async appendUpdates(id: string, u: readonly NewUpdate[]): Promise<AppendResult[]> {
    await this.#gate();
    return this.inner.appendUpdates(id, u);
  }
  async readUpdates(id: string, after: number, limit: number): Promise<StoredUpdate[]> {
    await this.#gate();
    return this.inner.readUpdates(id, after, limit);
  }
  async headSeq(id: string): Promise<number> {
    await this.#gate();
    return this.inner.headSeq(id);
  }
  async recordSnapshot(id: string, s: NewSnapshot): Promise<number> {
    await this.#gate();
    return this.inner.recordSnapshot(id, s);
  }
  async listSnapshots(id: string, limit: number): Promise<SnapshotMeta[]> {
    await this.#gate();
    return this.inner.listSnapshots(id, limit);
  }
  async ping(): Promise<void> {
    await this.#gate();
    return this.inner.ping();
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}

export class FaultyObjectStore implements ObjectStore {
  down = false;
  /** While true put/get never settle, like a storage backend that stops answering. */
  hang = false;
  /** Keys whose next get() returns these bytes instead (simulates corruption). */
  corrupt = new Map<string, Uint8Array>();

  constructor(readonly inner: ObjectStore) {}

  async put(key: string, bytes: Uint8Array): Promise<void> {
    if (this.hang) return new Promise(() => {});
    if (this.down) throw new Error("injected object store outage");
    return this.inner.put(key, bytes);
  }
  async get(key: string): Promise<Uint8Array | undefined> {
    if (this.hang) return new Promise(() => {});
    if (this.down) throw new Error("injected object store outage");
    return this.corrupt.get(key) ?? this.inner.get(key);
  }
  async delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }
}

/** Identity store that can be taken down, to prove the gateway fails closed. */
export class FaultyIdentityStore implements IdentityStore {
  down = false;
  /** While true authorize() never settles, like a database that stopped answering. */
  hang = false;
  /** Number of authorize() calls, to prove batching. */
  authorizeCalls = 0;

  constructor(readonly inner: IdentityStore) {}

  #gate(): void {
    if (this.down) throw new StoreUnavailableError("injected identity fault");
  }

  async upsertPrincipal(i: Parameters<IdentityStore["upsertPrincipal"]>[0], a: AuditInput): Promise<Principal> {
    this.#gate();
    return this.inner.upsertPrincipal(i, a);
  }
  async getPrincipal(id: string): Promise<Principal | undefined> {
    this.#gate();
    return this.inner.getPrincipal(id);
  }
  async disablePrincipal(id: string, atMs: number, a: AuditInput): Promise<number> {
    this.#gate();
    return this.inner.disablePrincipal(id, atMs, a);
  }
  async recordCertificate(r: CertificateRecord, a: AuditInput): Promise<void> {
    this.#gate();
    return this.inner.recordCertificate(r, a);
  }
  async getCertificate(serial: Uint8Array): Promise<CertificateRecord | undefined> {
    this.#gate();
    return this.inner.getCertificate(serial);
  }
  async revokeCertificate(serial: Uint8Array, atMs: number, reason: string, a: AuditInput): Promise<boolean> {
    this.#gate();
    return this.inner.revokeCertificate(serial, atMs, reason, a);
  }
  async setGrant(d: string, p: string, role: Role, by: string, atMs: number, a: AuditInput, g?: GrantGuard): Promise<void> {
    this.#gate();
    return this.inner.setGrant(d, p, role, by, atMs, a, g);
  }
  async removeGrant(d: string, p: string, a: AuditInput, g?: GrantGuard): Promise<boolean> {
    this.#gate();
    return this.inner.removeGrant(d, p, a, g);
  }
  async listGrants(d: string): Promise<Grant[]> {
    this.#gate();
    return this.inner.listGrants(d);
  }
  async roleOf(d: string, p: string): Promise<Role | undefined> {
    this.#gate();
    return this.inner.roleOf(d, p);
  }
  async authorize(q: readonly AuthorizeQuery[]): Promise<AuthorizeResult[]> {
    this.authorizeCalls++;
    this.#gate();
    if (this.hang) return new Promise(() => {});
    return this.inner.authorize(q);
  }
  async listAudit(after: number, limit: number): Promise<AuditEvent[]> {
    this.#gate();
    return this.inner.listAudit(after, limit);
  }
  async ping(): Promise<void> {
    this.#gate();
    return this.inner.ping();
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}
