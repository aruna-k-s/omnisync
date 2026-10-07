import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
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
import { DEVICE_CODE_TTL_MS, DEVICE_POLL_INTERVAL_MS, type ResolvedConfig } from "./config.js";
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

  /**
   * Who may manage a document's grants: its admins, or (`asOrg`) an organisation admin, who needs no grant of
   * their own but only for documents that exist. Anyone else sees "not found", so ids cannot be probed.
   */
  async #requireDocAdmin(actor: Principal, documentId: string, asOrg: boolean): Promise<void> {
    if (!DOC_ID.test(documentId)) throw new ServiceError("bad_request", "invalid document id");
    if (asOrg) {
      if (actor.orgRole !== "admin") throw new ServiceError("forbidden", "organisation admin only");
      if (!(await this.store.getDocument(documentId))) throw new ServiceError("not_found", "no such document");
      return;
    }
    const role = await this.store.roleOf(documentId, actor.id);
    if (role === undefined || !roleAtLeast(role, "admin")) throw new ServiceError("not_found", "no such document");
  }

  async listGrants(actor: Principal, documentId: string, asOrg = false): Promise<Grant[]> {
    await this.#requireDocAdmin(actor, documentId, asOrg);
    return this.store.listGrants(documentId);
  }

  async setGrant(actor: Principal, documentId: string, targetId: string, role: unknown, asOrg = false): Promise<void> {
    await this.#requireDocAdmin(actor, documentId, asOrg);
    if (typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) throw new ServiceError("bad_request", "invalid role");
    if (!(await this.store.getPrincipal(targetId))) throw new ServiceError("not_found", "no such principal");
    try {
      await this.store.setGrant(documentId, targetId, role as Role, actor.id, this.cfg.now(), this.#audit(actor.id, "grant.set", `${documentId}:${targetId}`, role), { keepOneAdmin: true });
    } catch (e) {
      throw asConflict(e);
    }
  }

  async removeGrant(actor: Principal, documentId: string, targetId: string, asOrg = false): Promise<void> {
    await this.#requireDocAdmin(actor, documentId, asOrg);
    let removed: boolean;
    try {
      removed = await this.store.removeGrant(documentId, targetId, this.#audit(actor.id, "grant.remove", `${documentId}:${targetId}`), { keepOneAdmin: true });
    } catch (e) {
      throw asConflict(e);
    }
    if (!removed) throw new ServiceError("not_found", "no such grant");
  }

  // ---- device-code login (docs/specs/device-login.md) ----

  /** Starts a request for a device that has no browser. Nothing here proves who the device is; a person must approve it. */
  async startDevice(rawLabel: unknown): Promise<DeviceStart> {
    const label = typeof rawLabel === "string" ? rawLabel.replace(LABEL_STRIP, "").trim().slice(0, 64) : "";
    const now = this.cfg.now();
    for (let attempt = 0; attempt < 5; attempt++) {
      const deviceCode = randomBytes(32).toString("base64url");
      let userCode = "";
      for (let i = 0; i < 8; i++) userCode += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
      const created = await this.store.createDeviceAuth(
        { deviceHash: new Uint8Array(sha256(deviceCode)), userCode, label, atMs: now, expiresAtMs: now + DEVICE_CODE_TTL_MS },
        this.#audit("system", "device.start", auditTarget(userCode), label),
      );
      if (created) return { deviceCode, userCode: formatUserCode(userCode), expiresInS: DEVICE_CODE_TTL_MS / 1000, intervalS: DEVICE_POLL_INTERVAL_MS / 1000 };
    }
    throw new ServiceError("conflict", "could not allocate a device code, try again");
  }

  async describeDevice(rawCode: string): Promise<{ label: string; createdAtMs: number; expiresAtMs: number; status: string }> {
    const code = normaliseUserCode(rawCode);
    const d = code === undefined ? undefined : await this.store.getDeviceAuth(code, this.cfg.now());
    if (!d) throw new ServiceError("not_found", "no such request");
    return { label: d.label, createdAtMs: d.createdAtMs, expiresAtMs: d.expiresAtMs, status: d.status };
  }

  async decideDevice(actor: Principal, rawCode: string, decision: "approve" | "deny"): Promise<void> {
    const code = normaliseUserCode(rawCode);
    if (code === undefined) throw new ServiceError("not_found", "no such request");
    const d = await this.store.getDeviceAuth(code, this.cfg.now());
    const outcome = d
      ? await this.store.decideDeviceAuth(code, decision, actor.id, this.cfg.now(), this.#audit(actor.id, `device.${decision}`, auditTarget(code), d.label))
      : "unknown";
    if (outcome === "unknown") throw new ServiceError("not_found", "no such request");
    if (outcome === "decided") throw new ServiceError("conflict", "this request was already decided");
  }

  /** The device's poll. A session is issued only for an approved request whose approver is still enabled, and only after the issue is audited. */
  async pollDevice(rawDeviceCode: unknown): Promise<DevicePollResult> {
    if (typeof rawDeviceCode !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(rawDeviceCode)) return { state: "expired_token" };
    const r = await this.store.pollDeviceAuth(new Uint8Array(sha256(rawDeviceCode)), this.cfg.now(), DEVICE_POLL_INTERVAL_MS);
    switch (r.state) {
      case "pending":
        return { state: "authorization_pending" };
      case "slow_down":
        return { state: "slow_down", intervalS: DEVICE_POLL_INTERVAL_MS / 1000 + 5 };
      case "denied":
        return { state: "access_denied" };
      case "expired":
        return { state: "expired_token" };
      case "approved": {
        const principal = await this.store.getPrincipal(r.principalId);
        if (!principal || principal.disabledAtMs !== undefined) return { state: "access_denied" };
        await this.store.appendAudit(this.#audit(principal.id, "device.token", auditTarget(r.userCode), r.label));
        return { state: "approved", sessionToken: await signSession(this.cfg.sessionSecret, principal.id, this.cfg.now(), this.cfg.sessionTtlMs) };
      }
    }
  }

  /** Records a ledger read before it happens; `appendAudit` failing means the read must not go ahead. */
  async auditLedgerExport(actor: Principal, tenant: string): Promise<void> {
    if (actor.orgRole !== "admin") throw new ServiceError("forbidden", "organisation admin only");
    await this.store.appendAudit(this.#audit(actor.id, "ledger.export", tenant));
  }
}

/** No vowels and no look-alikes: a code read aloud or typed from a terminal is hard to get wrong. */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-?[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
/** Control characters and the invisible direction marks that could make one label read as another. */
// eslint-disable-next-line no-control-regex -- removing control characters is the purpose
const LABEL_STRIP = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

export type DevicePollResult =
  | { readonly state: "approved"; readonly sessionToken: string }
  | { readonly state: "authorization_pending" | "access_denied" | "expired_token" }
  | { readonly state: "slow_down"; readonly intervalS: number };

export interface DeviceStart {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly expiresInS: number;
  readonly intervalS: number;
}

/** `ABCDEFGH` or `abcd-efgh` become `ABCDEFGH`; anything else is undefined. */
export function normaliseUserCode(raw: string): string | undefined {
  const up = raw.toUpperCase();
  return USER_CODE.test(up) ? up.replace("-", "") : undefined;
}
export const formatUserCode = (c: string): string => `${c.slice(0, 4)}-${c.slice(4)}`;
const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest();
/** What the audit trail says about a request: enough to match it to what the person saw, not enough to use it. */
const auditTarget = (userCode: string): string => `device:${sha256(userCode).toString("hex").slice(0, 8)}`;

function asConflict(e: unknown): unknown {
  return e instanceof LastAdminError ? new ServiceError("conflict", "a document needs at least one enabled admin") : e;
}

function parseSerial(hex: string): Uint8Array {
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new ServiceError("bad_request", "serial must be 32 hex characters");
  return new Uint8Array(Buffer.from(hex, "hex"));
}
