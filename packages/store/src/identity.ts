/**
 * Identity boundary (spec: docs/specs/identity.md). Principals sign in through
 * OIDC, hold short-lived certificates, and are granted roles on documents.
 * Every mutation carries an audit event written in the same transaction, so
 * "who changed access, when" can never be missing.
 */

export const ROLES = ["read", "write", "merge", "admin"] as const;
export type Role = (typeof ROLES)[number];
export const roleRank = (r: Role): number => ROLES.indexOf(r);
/** Roles are a total order: holding `merge` implies `write` implies `read`. */
export const roleAtLeast = (have: Role, need: Role): boolean => roleRank(have) >= roleRank(need);

export type OrgRole = "member" | "admin";

export interface Principal {
  /** Opaque id; also the certificate subject. */
  readonly id: string;
  readonly oidcIssuer: string;
  readonly oidcSubject: string;
  readonly email: string;
  readonly displayName: string;
  readonly orgRole: OrgRole;
  readonly disabledAtMs?: number;
}

export interface CertificateRecord {
  readonly serial: Uint8Array;
  readonly principalId: string;
  readonly keyId: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly issuedAtMs: number;
  readonly notBeforeMs: number;
  readonly notAfterMs: number;
  readonly revokedAtMs?: number;
  readonly revokeReason?: string;
  /** The issuer-signed certificate bytes, kept so an auditor can verify the chain offline. Absent on rows from before week 6. */
  readonly certificate?: Uint8Array;
}

export interface DocumentRecord {
  readonly id: string;
  readonly createdBy: string;
  readonly createdAtMs: number;
}

export interface Grant {
  readonly documentId: string;
  readonly principalId: string;
  readonly role: Role;
  readonly grantedBy: string;
  readonly grantedAtMs: number;
}

/** Thrown when a change would leave a document without an enabled admin. */
export class LastAdminError extends Error {
  override readonly name = "LastAdminError";
  constructor() {
    super("a document needs at least one enabled admin");
  }
}

export interface GrantGuard {
  /**
   * Refuse, atomically with the change, any demotion or removal that would leave no enabled admin.
   * The check and the write are one transaction, so two admins demoting each other cannot both succeed.
   */
  readonly keepOneAdmin?: boolean;
}

export interface AuditInput {
  readonly atMs: number;
  /** Principal id, or "system". */
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly detail?: string;
}
export interface AuditEvent extends AuditInput {
  readonly id: number;
  readonly detail: string;
}

export interface AuthorizeQuery {
  readonly serial: Uint8Array;
  /** Certificate subject. Must match the principal recorded for the serial. */
  readonly principalId: string;
  readonly documentId: string;
}

export type AuthorizeResult =
  | { readonly ok: true; readonly role: Role; readonly orgRole: OrgRole }
  | { readonly ok: false; readonly reason: "unknown_certificate" | "revoked" | "disabled" | "no_access" };

export interface IdentityStore {
  /** Creates or refreshes the principal for an OIDC identity. Never re-enables a disabled one. */
  upsertPrincipal(
    input: Pick<Principal, "oidcIssuer" | "oidcSubject" | "email" | "displayName" | "orgRole">,
    audit: AuditInput,
  ): Promise<Principal>;
  getPrincipal(id: string): Promise<Principal | undefined>;
  /** Ascending by id (byte order), id > `after` when given. For the admin console. */
  listPrincipals(after: string | undefined, limit: number): Promise<Principal[]>;
  /** Disables a principal and revokes all their certificates, atomically. Returns certificates revoked. */
  disablePrincipal(id: string, atMs: number, audit: AuditInput): Promise<number>;

  recordCertificate(record: CertificateRecord, audit: AuditInput): Promise<void>;
  getCertificate(serial: Uint8Array): Promise<CertificateRecord | undefined>;
  /** True if this call revoked it; false if it was already revoked or unknown. */
  revokeCertificate(serial: Uint8Array, atMs: number, reason: string, audit: AuditInput): Promise<boolean>;

  /**
   * Registers a document and makes `createdBy` its admin, with one audit event, atomically.
   * Returns false, changing nothing, if the id is already registered.
   */
  createDocument(id: string, createdBy: string, atMs: number, audit: AuditInput): Promise<boolean>;
  getDocument(id: string): Promise<DocumentRecord | undefined>;
  /** Ascending by id (byte order), id > `after` when given. For the admin console. */
  listDocumentRecords(after: string | undefined, limit: number): Promise<DocumentRecord[]>;

  /** Certificates in ascending serial order, serial > `after` when given. For ledger export. */
  listCertificates(after: Uint8Array | undefined, limit: number): Promise<CertificateRecord[]>;
  /** One principal's certificates, newest first, at most 500. */
  listCertificatesOf(principalId: string): Promise<CertificateRecord[]>;

  /** Creates or changes a grant. */
  setGrant(
    documentId: string,
    principalId: string,
    role: Role,
    grantedBy: string,
    atMs: number,
    audit: AuditInput,
    guard?: GrantGuard,
  ): Promise<void>;
  removeGrant(documentId: string, principalId: string, audit: AuditInput, guard?: GrantGuard): Promise<boolean>;
  listGrants(documentId: string): Promise<Grant[]>;
  roleOf(documentId: string, principalId: string): Promise<Role | undefined>;

  /** The gateway's hot path: one batched call answers many connections. Order matches `queries`. */
  authorize(queries: readonly AuthorizeQuery[]): Promise<AuthorizeResult[]>;

  /** Records one event with no other change (a read worth a trace, such as a ledger export). */
  appendAudit(audit: AuditInput): Promise<void>;
  /** Oldest first, ids greater than `afterId`. */
  listAudit(afterId: number, limit: number): Promise<AuditEvent[]>;

  ping(): Promise<void>;
  close(): Promise<void>;
}
