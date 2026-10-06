import { randomBytes } from "node:crypto";
import type pg from "pg";
import { LastAdminError } from "./identity.js";
import type {
  AuditEvent,
  AuditInput,
  AuthorizeQuery,
  AuthorizeResult,
  CertificateRecord,
  DocumentRecord,
  Grant,
  GrantGuard,
  IdentityStore,
  OrgRole,
  Principal,
  Role,
} from "./identity.js";
import { StoreUnavailableError } from "./types.js";

const toBytes = (b: Buffer): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice();
const buf = (b: Uint8Array): Buffer => Buffer.from(b.buffer, b.byteOffset, b.byteLength);

interface PrincipalRow {
  id: string;
  oidc_issuer: string;
  oidc_subject: string;
  email: string;
  display_name: string;
  org_role: OrgRole;
  disabled_at: string | null;
}
const principalOf = (r: PrincipalRow): Principal => ({
  id: r.id,
  oidcIssuer: r.oidc_issuer,
  oidcSubject: r.oidc_subject,
  email: r.email,
  displayName: r.display_name,
  orgRole: r.org_role,
  ...(r.disabled_at !== null ? { disabledAtMs: Number(r.disabled_at) } : {}),
});

interface CertRow {
  serial: Buffer;
  principal_id: string;
  key_id: Buffer;
  public_key: Buffer;
  issued_at: string;
  not_before: string;
  not_after: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  certificate: Buffer | null;
}
const certOf = (row: CertRow): CertificateRecord => ({
  serial: toBytes(row.serial),
  principalId: row.principal_id,
  keyId: toBytes(row.key_id),
  publicKey: toBytes(row.public_key),
  issuedAtMs: Number(row.issued_at),
  notBeforeMs: Number(row.not_before),
  notAfterMs: Number(row.not_after),
  ...(row.revoked_at !== null ? { revokedAtMs: Number(row.revoked_at) } : {}),
  ...(row.revoke_reason !== null ? { revokeReason: row.revoke_reason } : {}),
  ...(row.certificate !== null ? { certificate: toBytes(row.certificate) } : {}),
});

/** PostgreSQL IdentityStore on the same pool (and schema) as PgDocumentStore. */
export class PgIdentityStore implements IdentityStore {
  constructor(readonly pool: pg.Pool) {}

  async upsertPrincipal(
    input: Pick<Principal, "oidcIssuer" | "oidcSubject" | "email" | "displayName" | "orgRole">,
    audit: AuditInput,
  ): Promise<Principal> {
    return this.#tx(async (c) => {
      const r = await c.query<PrincipalRow>(
        `INSERT INTO principals (id, oidc_issuer, oidc_subject, email, display_name, org_role)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (oidc_issuer, oidc_subject)
         DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, org_role = EXCLUDED.org_role
         RETURNING *`,
        [`p_${randomBytes(8).toString("hex")}`, input.oidcIssuer, input.oidcSubject, input.email, input.displayName, input.orgRole],
      );
      const p = principalOf(r.rows[0] as PrincipalRow);
      await this.#audit(c, { ...audit, target: audit.target || p.id });
      return p;
    });
  }

  async getPrincipal(id: string): Promise<Principal | undefined> {
    const r = await this.#query<PrincipalRow>("SELECT * FROM principals WHERE id = $1", [id]);
    return r.rows[0] ? principalOf(r.rows[0]) : undefined;
  }

  async disablePrincipal(id: string, atMs: number, audit: AuditInput): Promise<number> {
    return this.#tx(async (c) => {
      const p = await c.query("UPDATE principals SET disabled_at = COALESCE(disabled_at, $2) WHERE id = $1", [id, atMs]);
      if (p.rowCount === 0) return 0;
      const r = await c.query(
        "UPDATE certificates SET revoked_at = $2, revoke_reason = 'principal_disabled' WHERE principal_id = $1 AND revoked_at IS NULL",
        [id, atMs],
      );
      await this.#audit(c, audit);
      return r.rowCount ?? 0;
    });
  }

  async recordCertificate(rec: CertificateRecord, audit: AuditInput): Promise<void> {
    await this.#tx(async (c) => {
      await c.query(
        `INSERT INTO certificates (serial, principal_id, key_id, public_key, issued_at, not_before, not_after, certificate)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          buf(rec.serial), rec.principalId, buf(rec.keyId), buf(rec.publicKey), rec.issuedAtMs, rec.notBeforeMs, rec.notAfterMs,
          rec.certificate ? buf(rec.certificate) : null,
        ],
      );
      await this.#audit(c, audit);
    });
  }

  async getCertificate(serial: Uint8Array): Promise<CertificateRecord | undefined> {
    const r = await this.#query<CertRow>("SELECT * FROM certificates WHERE serial = $1", [buf(serial)]);
    return r.rows[0] ? certOf(r.rows[0]) : undefined;
  }

  async listCertificates(after: Uint8Array | undefined, limit: number): Promise<CertificateRecord[]> {
    const r = await this.#query<CertRow>(
      "SELECT * FROM certificates WHERE ($1::bytea IS NULL OR serial > $1::bytea) ORDER BY serial LIMIT $2",
      [after ? buf(after) : null, limit],
    );
    return r.rows.map(certOf);
  }

  async createDocument(id: string, createdBy: string, atMs: number, audit: AuditInput): Promise<boolean> {
    return this.#tx(async (c) => {
      const ins = await c.query("INSERT INTO document_registry (id, created_by, created_at_ms) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [id, createdBy, atMs]);
      if (ins.rowCount !== 1) return false;
      await c.query(
        "INSERT INTO document_grants (document_id, principal_id, role, granted_by, granted_at) VALUES ($1, $2, 'admin', $2, $3)",
        [id, createdBy, atMs],
      );
      await this.#audit(c, audit);
      return true;
    });
  }

  async getDocument(id: string): Promise<DocumentRecord | undefined> {
    const r = await this.#query<{ id: string; created_by: string; created_at_ms: string }>("SELECT * FROM document_registry WHERE id = $1", [id]);
    const row = r.rows[0];
    return row ? { id: row.id, createdBy: row.created_by, createdAtMs: Number(row.created_at_ms) } : undefined;
  }

  async revokeCertificate(serial: Uint8Array, atMs: number, reason: string, audit: AuditInput): Promise<boolean> {
    return this.#tx(async (c) => {
      const r = await c.query("UPDATE certificates SET revoked_at = $2, revoke_reason = $3 WHERE serial = $1 AND revoked_at IS NULL", [
        buf(serial),
        atMs,
        reason,
      ]);
      if (r.rowCount !== 1) return false;
      await this.#audit(c, audit);
      return true;
    });
  }

  /** Locks the document's grants, then refuses a change that would leave no enabled admin. */
  async #guardLastAdmin(c: pg.PoolClient, documentId: string, principalId: string): Promise<void> {
    // Serialises every guarded change to this document: the second one re-reads after the first commits.
    await c.query("SELECT 1 FROM document_grants WHERE document_id = $1 FOR UPDATE", [documentId]);
    const current = await c.query<{ role: Role }>("SELECT role FROM document_grants WHERE document_id = $1 AND principal_id = $2", [documentId, principalId]);
    if (current.rows[0]?.role !== "admin") return;
    const others = await c.query(
      `SELECT 1 FROM document_grants g JOIN principals p ON p.id = g.principal_id
        WHERE g.document_id = $1 AND g.role = 'admin' AND g.principal_id <> $2 AND p.disabled_at IS NULL LIMIT 1`,
      [documentId, principalId],
    );
    if (others.rowCount === 0) throw new LastAdminError();
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
    await this.#tx(async (c) => {
      if (guard?.keepOneAdmin && role !== "admin") await this.#guardLastAdmin(c, documentId, principalId);
      await c.query(
        `INSERT INTO document_grants (document_id, principal_id, role, granted_by, granted_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (document_id, principal_id)
         DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at`,
        [documentId, principalId, role, grantedBy, atMs],
      );
      await this.#audit(c, audit);
    });
  }

  async removeGrant(documentId: string, principalId: string, audit: AuditInput, guard?: GrantGuard): Promise<boolean> {
    return this.#tx(async (c) => {
      if (guard?.keepOneAdmin) await this.#guardLastAdmin(c, documentId, principalId);
      const r = await c.query("DELETE FROM document_grants WHERE document_id = $1 AND principal_id = $2", [documentId, principalId]);
      if (r.rowCount !== 1) return false;
      await this.#audit(c, audit);
      return true;
    });
  }

  async listGrants(documentId: string): Promise<Grant[]> {
    const r = await this.#query<{ document_id: string; principal_id: string; role: Role; granted_by: string; granted_at: string }>(
      "SELECT * FROM document_grants WHERE document_id = $1 ORDER BY principal_id",
      [documentId],
    );
    return r.rows.map((g) => ({
      documentId: g.document_id,
      principalId: g.principal_id,
      role: g.role,
      grantedBy: g.granted_by,
      grantedAtMs: Number(g.granted_at),
    }));
  }

  async roleOf(documentId: string, principalId: string): Promise<Role | undefined> {
    const r = await this.#query<{ role: Role }>("SELECT role FROM document_grants WHERE document_id = $1 AND principal_id = $2", [
      documentId,
      principalId,
    ]);
    return r.rows[0]?.role;
  }

  async authorize(queries: readonly AuthorizeQuery[]): Promise<AuthorizeResult[]> {
    if (queries.length === 0) return [];
    // One round trip for the whole batch; the join yields one row per query position.
    const r = await this.#query<{
      i: number;
      principal_id: string | null;
      revoked_at: string | null;
      disabled_at: string | null;
      org_role: OrgRole | null;
      role: Role | null;
    }>(
      `SELECT q.i::int AS i, c.principal_id, c.revoked_at, p.disabled_at, p.org_role, g.role
         FROM unnest($1::bytea[], $2::text[], $3::text[]) WITH ORDINALITY AS q(serial, principal_id, document_id, i)
         LEFT JOIN certificates c ON c.serial = q.serial AND c.principal_id = q.principal_id
         LEFT JOIN principals p ON p.id = c.principal_id
         LEFT JOIN document_grants g ON g.document_id = q.document_id AND g.principal_id = c.principal_id`,
      [queries.map((q) => buf(q.serial)), queries.map((q) => q.principalId), queries.map((q) => q.documentId)],
    );
    const out: AuthorizeResult[] = queries.map(() => ({ ok: false, reason: "unknown_certificate" }));
    for (const row of r.rows) {
      out[row.i - 1] =
        row.principal_id === null || row.org_role === null
          ? { ok: false, reason: "unknown_certificate" }
          : row.revoked_at !== null
            ? { ok: false, reason: "revoked" }
            : row.disabled_at !== null
              ? { ok: false, reason: "disabled" }
              : row.role === null
                ? { ok: false, reason: "no_access" }
                : { ok: true, role: row.role, orgRole: row.org_role };
    }
    return out;
  }

  async listAudit(afterId: number, limit: number): Promise<AuditEvent[]> {
    const r = await this.#query<{ id: string; at: string; actor: string; action: string; target: string; detail: string }>(
      "SELECT * FROM audit_events WHERE id > $1 ORDER BY id LIMIT $2",
      [afterId, limit],
    );
    return r.rows.map((e) => ({ id: Number(e.id), atMs: Number(e.at), actor: e.actor, action: e.action, target: e.target, detail: e.detail }));
  }

  async ping(): Promise<void> {
    await this.#query("SELECT 1", []);
  }

  /** The pool belongs to the DocumentStore; closing it there closes it here. */
  async close(): Promise<void> {}

  async #audit(c: pg.PoolClient, a: AuditInput): Promise<void> {
    await c.query("INSERT INTO audit_events (at, actor, action, target, detail) VALUES ($1, $2, $3, $4, $5)", [
      a.atMs,
      a.actor,
      a.action,
      a.target,
      a.detail ?? "",
    ]);
  }

  async #query<R extends pg.QueryResultRow>(text: string, values: unknown[]): Promise<pg.QueryResult<R>> {
    try {
      return await this.pool.query<R>(text, values);
    } catch (e) {
      throw wrap(e);
    }
  }

  async #tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch (e) {
      throw wrap(e);
    }
    let broken = false;
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        broken = true;
      }
      if (e instanceof LastAdminError) throw e; // a rule violation, not an outage
      throw wrap(e);
    } finally {
      client.release(broken || undefined);
    }
  }
}

function wrap(e: unknown): StoreUnavailableError {
  if (e instanceof StoreUnavailableError) return e;
  return new StoreUnavailableError(`postgres: ${(e as Error).message}`, { cause: e });
}
