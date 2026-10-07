import { randomBytes } from "node:crypto";
import { LastAdminError } from "./identity.js";
import type {
  AuditEvent,
  AuditInput,
  AuthorizeQuery,
  AuthorizeResult,
  CertificateRecord,
  DeviceAuth,
  DeviceAuthInput,
  DevicePoll,
  DocumentRecord,
  Grant,
  GrantGuard,
  IdentityStore,
  Principal,
  Role,
} from "./identity.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

interface DeviceRow {
  userCode: string;
  label: string;
  createdAtMs: number;
  expiresAtMs: number;
  status: "pending" | "approved" | "denied";
  principalId?: string;
  lastPollMs?: number;
}

/** Reference IdentityStore. Same contract tests as Postgres. */
export class MemoryIdentityStore implements IdentityStore {
  readonly #principals = new Map<string, Principal>();
  readonly #byOidc = new Map<string, string>();
  readonly #certs = new Map<string, CertificateRecord>();
  readonly #grants = new Map<string, Grant>();
  readonly #audit: AuditEvent[] = [];
  readonly #documents = new Map<string, DocumentRecord>();
  readonly #devices = new Map<string, DeviceRow>(); // by hex of the device hash

  #log(a: AuditInput): void {
    this.#audit.push({ ...a, detail: a.detail ?? "", id: this.#audit.length + 1 });
  }

  async upsertPrincipal(
    input: Pick<Principal, "oidcIssuer" | "oidcSubject" | "email" | "displayName" | "orgRole">,
    audit: AuditInput,
  ): Promise<Principal> {
    const oidcKey = `${input.oidcIssuer}\n${input.oidcSubject}`;
    const existingId = this.#byOidc.get(oidcKey);
    const existing = existingId === undefined ? undefined : this.#principals.get(existingId);
    const id = existing?.id ?? `p_${randomBytes(8).toString("hex")}`;
    const p: Principal = {
      id,
      oidcIssuer: input.oidcIssuer,
      oidcSubject: input.oidcSubject,
      email: input.email,
      displayName: input.displayName,
      orgRole: input.orgRole,
      ...(existing?.disabledAtMs !== undefined ? { disabledAtMs: existing.disabledAtMs } : {}),
    };
    this.#principals.set(id, p);
    this.#byOidc.set(oidcKey, id);
    this.#log({ ...audit, target: audit.target || id });
    return p;
  }

  async getPrincipal(id: string): Promise<Principal | undefined> {
    return this.#principals.get(id);
  }

  async listPrincipals(after: string | undefined, limit: number): Promise<Principal[]> {
    return [...this.#principals.values()].filter((p) => after === undefined || p.id > after).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, limit);
  }

  async disablePrincipal(id: string, atMs: number, audit: AuditInput): Promise<number> {
    const p = this.#principals.get(id);
    if (!p) return 0;
    if (p.disabledAtMs === undefined) this.#principals.set(id, { ...p, disabledAtMs: atMs });
    let n = 0;
    for (const [k, c] of this.#certs) {
      if (c.principalId === id && c.revokedAtMs === undefined) {
        this.#certs.set(k, { ...c, revokedAtMs: atMs, revokeReason: "principal_disabled" });
        n++;
      }
    }
    this.#log(audit);
    return n;
  }

  async recordCertificate(record: CertificateRecord, audit: AuditInput): Promise<void> {
    if (!this.#principals.has(record.principalId)) throw new Error("unknown principal");
    const k = hex(record.serial);
    if (this.#certs.has(k)) throw new Error("certificate serial already recorded");
    this.#certs.set(k, {
      ...record,
      serial: record.serial.slice(),
      keyId: record.keyId.slice(),
      publicKey: record.publicKey.slice(),
      ...(record.certificate ? { certificate: record.certificate.slice() } : {}),
    });
    this.#log(audit);
  }

  async getCertificate(serial: Uint8Array): Promise<CertificateRecord | undefined> {
    return this.#certs.get(hex(serial));
  }

  async revokeCertificate(serial: Uint8Array, atMs: number, reason: string, audit: AuditInput): Promise<boolean> {
    const k = hex(serial);
    const c = this.#certs.get(k);
    if (!c || c.revokedAtMs !== undefined) return false;
    this.#certs.set(k, { ...c, revokedAtMs: atMs, revokeReason: reason });
    this.#log(audit);
    return true;
  }

  async listCertificates(after: Uint8Array | undefined, limit: number): Promise<CertificateRecord[]> {
    const floor = after === undefined ? undefined : hex(after);
    return [...this.#certs.entries()]
      .filter(([k]) => floor === undefined || k > floor)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .slice(0, limit)
      .map(([, c]) => c);
  }

  async createDocument(id: string, createdBy: string, atMs: number, audit: AuditInput): Promise<boolean> {
    if (this.#documents.has(id)) return false;
    if (!this.#principals.has(createdBy)) throw new Error("unknown principal");
    this.#documents.set(id, { id, createdBy, createdAtMs: atMs });
    this.#grants.set(`${id}\n${createdBy}`, { documentId: id, principalId: createdBy, role: "admin", grantedBy: createdBy, grantedAtMs: atMs });
    this.#log(audit);
    return true;
  }

  async getDocument(id: string): Promise<DocumentRecord | undefined> {
    return this.#documents.get(id);
  }

  async listDocumentRecords(after: string | undefined, limit: number): Promise<DocumentRecord[]> {
    return [...this.#documents.values()].filter((d) => after === undefined || d.id > after).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, limit);
  }

  async listCertificatesOf(principalId: string): Promise<CertificateRecord[]> {
    return [...this.#certs.values()]
      .filter((c) => c.principalId === principalId)
      .sort((a, b) => b.issuedAtMs - a.issuedAtMs || (hex(a.serial) < hex(b.serial) ? -1 : 1))
      .slice(0, 500);
  }

  async appendAudit(audit: AuditInput): Promise<void> {
    this.#log(audit);
  }

  #assertAnotherAdmin(documentId: string, excluding: string): void {
    const other = [...this.#grants.values()].some(
      (g) => g.documentId === documentId && g.role === "admin" && g.principalId !== excluding && this.#principals.get(g.principalId)?.disabledAtMs === undefined,
    );
    if (!other) throw new LastAdminError();
  }

  async setGrant(
    documentId: string,
    principalId: string,
    role: Role,
    grantedBy: string,
    atMs: number,
    audit: AuditInput,
    guard?: GrantGuard,
  ): Promise<void> {
    if (!this.#principals.has(principalId)) throw new Error("unknown principal");
    if (guard?.keepOneAdmin && role !== "admin" && this.#grants.get(`${documentId}\n${principalId}`)?.role === "admin") {
      this.#assertAnotherAdmin(documentId, principalId);
    }
    this.#grants.set(`${documentId}\n${principalId}`, { documentId, principalId, role, grantedBy, grantedAtMs: atMs });
    this.#log(audit);
  }

  async removeGrant(documentId: string, principalId: string, audit: AuditInput, guard?: GrantGuard): Promise<boolean> {
    if (guard?.keepOneAdmin && this.#grants.get(`${documentId}\n${principalId}`)?.role === "admin") {
      this.#assertAnotherAdmin(documentId, principalId);
    }
    const removed = this.#grants.delete(`${documentId}\n${principalId}`);
    if (removed) this.#log(audit);
    return removed;
  }

  async listGrants(documentId: string): Promise<Grant[]> {
    return [...this.#grants.values()].filter((g) => g.documentId === documentId).sort((a, b) => a.principalId.localeCompare(b.principalId));
  }

  async roleOf(documentId: string, principalId: string): Promise<Role | undefined> {
    return this.#grants.get(`${documentId}\n${principalId}`)?.role;
  }

  async authorize(queries: readonly AuthorizeQuery[]): Promise<AuthorizeResult[]> {
    return queries.map((q): AuthorizeResult => {
      const c = this.#certs.get(hex(q.serial));
      if (!c || c.principalId !== q.principalId) return { ok: false, reason: "unknown_certificate" };
      if (c.revokedAtMs !== undefined) return { ok: false, reason: "revoked" };
      const p = this.#principals.get(c.principalId);
      if (!p) return { ok: false, reason: "unknown_certificate" };
      if (p.disabledAtMs !== undefined) return { ok: false, reason: "disabled" };
      const g = this.#grants.get(`${q.documentId}\n${q.principalId}`);
      return g ? { ok: true, role: g.role, orgRole: p.orgRole } : { ok: false, reason: "no_access" };
    });
  }

  async listAudit(afterId: number, limit: number): Promise<AuditEvent[]> {
    return this.#audit.filter((e) => e.id > afterId).slice(0, limit);
  }

  async createDeviceAuth(input: DeviceAuthInput, audit: AuditInput): Promise<boolean> {
    const key = hex(input.deviceHash);
    let purged = 0;
    for (const [k, d] of this.#devices) {
      if (d.expiresAtMs <= input.atMs && (purged++ < 100 || k === key || d.userCode === input.userCode)) this.#devices.delete(k);
    }
    if (this.#devices.has(key)) return false;
    for (const d of this.#devices.values()) if (d.userCode === input.userCode) return false;
    this.#devices.set(key, { userCode: input.userCode, label: input.label, createdAtMs: input.atMs, expiresAtMs: input.expiresAtMs, status: "pending" });
    this.#log(audit);
    return true;
  }

  #deviceByCode(userCode: string, atMs: number): DeviceRow | undefined {
    for (const d of this.#devices.values()) if (d.userCode === userCode && d.expiresAtMs > atMs) return d;
    return undefined;
  }

  async getDeviceAuth(userCode: string, atMs: number): Promise<DeviceAuth | undefined> {
    const d = this.#deviceByCode(userCode, atMs);
    return d && { userCode: d.userCode, label: d.label, createdAtMs: d.createdAtMs, expiresAtMs: d.expiresAtMs, status: d.status };
  }

  async decideDeviceAuth(userCode: string, decision: "approve" | "deny", principalId: string, atMs: number, audit: AuditInput): Promise<"ok" | "unknown" | "decided"> {
    const d = this.#deviceByCode(userCode, atMs);
    if (!d) return "unknown";
    if (d.status !== "pending") return "decided";
    d.status = decision === "approve" ? "approved" : "denied";
    if (decision === "approve") d.principalId = principalId;
    this.#log(audit);
    return "ok";
  }

  async pollDeviceAuth(deviceHash: Uint8Array, atMs: number, minIntervalMs: number): Promise<DevicePoll> {
    const key = hex(deviceHash);
    const d = this.#devices.get(key);
    if (!d || d.expiresAtMs <= atMs) {
      this.#devices.delete(key);
      return { state: "expired" };
    }
    if (d.status === "approved") {
      this.#devices.delete(key);
      return { state: "approved", principalId: d.principalId as string, userCode: d.userCode, label: d.label };
    }
    if (d.status === "denied") {
      this.#devices.delete(key);
      return { state: "denied" };
    }
    const tooSoon = d.lastPollMs !== undefined && atMs - d.lastPollMs < minIntervalMs;
    d.lastPollMs = atMs;
    return { state: tooSoon ? "slow_down" : "pending" };
  }

  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}
