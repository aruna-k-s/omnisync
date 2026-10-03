import { randomBytes } from "node:crypto";
import { LastAdminError } from "./identity.js";
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

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** Reference IdentityStore. Same contract tests as Postgres. */
export class MemoryIdentityStore implements IdentityStore {
  readonly #principals = new Map<string, Principal>();
  readonly #byOidc = new Map<string, string>();
  readonly #certs = new Map<string, CertificateRecord>();
  readonly #grants = new Map<string, Grant>();
  readonly #audit: AuditEvent[] = [];

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
    this.#certs.set(k, { ...record, serial: record.serial.slice(), keyId: record.keyId.slice(), publicKey: record.publicKey.slice() });
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

  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}
