import { randomBytes, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { issueCertificate, verifyEnrollmentProof } from "@omnisync/crypto";
import { bytesToHex, keyIdOf } from "@omnisync/protocol";
import {
  LastAdminError,
  ROLES,
  roleAtLeast,
  type AuditInput,
  type Grant,
  type IdentityStore,
  type Principal,
  type Role,
} from "@omnisync/store";
import type { OidcIdentity } from "./oidc.js";
import { CONFIG, IDENTITY } from "./tokens.js";
import type { ResolvedConfig } from "./config.js";
import { signSession } from "./session.js";

export type ServiceErrorCode = "forbidden" | "not_found" | "bad_request" | "conflict";

export class ServiceError extends Error {
  override readonly name = "ServiceError";
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface IssuedCertificate {
  readonly certificate: Uint8Array;
  readonly serial: string;
  readonly subject: string;
  readonly notBeforeMs: number;
  readonly notAfterMs: number;
}

/** Canonical lowercase UUID, as minted by `createDocument`. */
const DOC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** All state changes go through here, each with its audit event, so rules live in one place. */
@Injectable()
export class IdentityService {
  constructor(
    @Inject(CONFIG) private readonly cfg: ResolvedConfig,
    @Inject(IDENTITY) readonly store: IdentityStore,
  ) {}

  #audit(actor: string, action: string, target: string, detail = ""): AuditInput {
    return { atMs: this.cfg.now(), actor, action, target, detail };
  }

  /** Completes a login: creates or refreshes the principal and returns a session token. */
  async login(id: OidcIdentity): Promise<{ principal: Principal; sessionToken: string }> {
    // An address the IdP has not verified proves nothing: anyone could register someone else's email.
    const orgRole = id.emailVerified && this.cfg.adminEmails.has(id.email.toLowerCase()) ? "admin" : "member";
    const principal = await this.store.upsertPrincipal(
      { oidcIssuer: id.issuer, oidcSubject: id.subject, email: id.email, displayName: id.name, orgRole },
      this.#audit("system", "auth.login", "", `${id.issuer}`),
    );
    if (principal.disabledAtMs !== undefined) throw new ServiceError("forbidden", "account disabled");
    const sessionToken = await signSession(this.cfg.sessionSecret, principal.id, this.cfg.now(), this.cfg.sessionTtlMs);
    return { principal, sessionToken };
  }

  async issueCertificate(
    principal: Principal,
    input: { publicKey: Uint8Array; proof: Uint8Array; lifetimeMs?: number },
  ): Promise<IssuedCertificate> {
    if (input.publicKey.length !== 32) throw new ServiceError("bad_request", "publicKey must be 32 bytes");
    if (!verifyEnrollmentProof(principal.id, input.publicKey, input.proof)) {
      throw new ServiceError("bad_request", "proof of key possession is invalid");
    }
    const { certMinLifetimeMs: min, certMaxLifetimeMs: max } = this.cfg;
    const wanted = input.lifetimeMs ?? this.cfg.certDefaultLifetimeMs;
    if (!Number.isFinite(wanted) || wanted < min) throw new ServiceError("bad_request", `lifetime must be at least ${min} ms`);
    const lifetime = Math.min(wanted, max);

    const now = this.cfg.now();
    const serial = new Uint8Array(randomBytes(16));
    const certificate = issueCertificate(
      { subject: principal.id, subjectPublicKey: input.publicKey, issuedAtMs: now, notAfterMs: now + lifetime, serial },
      this.cfg.issuer,
    );
    // Recorded before it is returned: a certificate the gateway cannot find is a certificate nobody can use.
    await this.store.recordCertificate(
      {
        serial,
        principalId: principal.id,
        keyId: keyIdOf(input.publicKey),
        publicKey: input.publicKey,
        issuedAtMs: now,
        notBeforeMs: now,
        notAfterMs: now + lifetime,
        // The signed bytes, so an auditor can verify the whole chain offline (ledger export).
        certificate,
      },
      this.#audit(principal.id, "cert.issue", bytesToHex(serial), `lifetime_ms=${lifetime}`),
    );
    return { certificate, serial: bytesToHex(serial), subject: principal.id, notBeforeMs: now, notAfterMs: now + lifetime };
  }

  async revokeCertificate(actor: Principal, serialHex: string, reason: string): Promise<void> {
    const serial = parseSerial(serialHex);
    const cert = await this.store.getCertificate(serial);
    if (!cert) throw new ServiceError("not_found", "no such certificate");
    if (cert.principalId !== actor.id && actor.orgRole !== "admin") throw new ServiceError("forbidden", "not your certificate");
    const done = await this.store.revokeCertificate(
      serial,
      this.cfg.now(),
      reason.slice(0, 200) || "revoked",
      this.#audit(actor.id, "cert.revoke", serialHex, reason.slice(0, 200)),
    );
    if (!done) throw new ServiceError("conflict", "already revoked");
  }

  async disablePrincipal(actor: Principal, targetId: string): Promise<number> {
    if (actor.orgRole !== "admin") throw new ServiceError("forbidden", "organisation admin only");
    if (actor.id === targetId) throw new ServiceError("bad_request", "cannot disable yourself");
    if (!(await this.store.getPrincipal(targetId))) throw new ServiceError("not_found", "no such principal");
    return this.store.disablePrincipal(targetId, this.cfg.now(), this.#audit(actor.id, "principal.disable", targetId));
  }

  async createDocument(actor: Principal): Promise<string> {
    const id = randomUUID();
    // Registry row, the creator's admin grant and the audit event commit together or not at all.
    if (!(await this.store.createDocument(id, actor.id, this.cfg.now(), this.#audit(actor.id, "document.create", id)))) {
      throw new ServiceError("conflict", "document id collision, try again");
    }
    return id;
  }

  async #requireDocAdmin(actor: Principal, documentId: string): Promise<void> {
    if (!DOC_ID.test(documentId)) throw new ServiceError("bad_request", "invalid document id");
    const role = await this.store.roleOf(documentId, actor.id);
    // Not-found and not-admin look the same, so ids cannot be probed.
    if (role === undefined || !roleAtLeast(role, "admin")) throw new ServiceError("not_found", "no such document");
  }

  async listGrants(actor: Principal, documentId: string): Promise<Grant[]> {
    await this.#requireDocAdmin(actor, documentId);
    return this.store.listGrants(documentId);
  }

  async setGrant(actor: Principal, documentId: string, targetId: string, role: unknown): Promise<void> {
    await this.#requireDocAdmin(actor, documentId);
    if (typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) throw new ServiceError("bad_request", "invalid role");
    if (!(await this.store.getPrincipal(targetId))) throw new ServiceError("not_found", "no such principal");
    try {
      await this.store.setGrant(documentId, targetId, role as Role, actor.id, this.cfg.now(), this.#audit(actor.id, "grant.set", `${documentId}:${targetId}`, role), { keepOneAdmin: true });
    } catch (e) {
      throw asConflict(e);
    }
  }

  async removeGrant(actor: Principal, documentId: string, targetId: string): Promise<void> {
    await this.#requireDocAdmin(actor, documentId);
    let removed: boolean;
    try {
      removed = await this.store.removeGrant(documentId, targetId, this.#audit(actor.id, "grant.remove", `${documentId}:${targetId}`), { keepOneAdmin: true });
    } catch (e) {
      throw asConflict(e);
    }
    if (!removed) throw new ServiceError("not_found", "no such grant");
  }
}

function asConflict(e: unknown): unknown {
  return e instanceof LastAdminError ? new ServiceError("conflict", "a document needs at least one enabled admin") : e;
}

function parseSerial(hex: string): Uint8Array {
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new ServiceError("bad_request", "serial must be 32 hex characters");
  return new Uint8Array(Buffer.from(hex, "hex"));
}
