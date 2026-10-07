/**
 * Typed client for the control plane's admin API (spec: docs/specs/admin-api.md). Framework-free so it is tested
 * without a browser; the Angular layer only wires it to a session.
 */

export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Role = "read" | "write" | "merge" | "admin";
export const ROLES: readonly Role[] = ["read", "write", "merge", "admin"];

export interface Person {
  id: string;
  email: string;
  displayName: string;
  orgRole: "member" | "admin";
  disabledAtMs?: number;
}
export interface CertInfo {
  serial: string;
  keyId: string;
  issuedAtMs: number;
  notBeforeMs: number;
  notAfterMs: number;
  revokedAtMs?: number;
  revokeReason?: string;
}
export interface DocInfo {
  id: string;
  createdBy: string;
  createdAtMs: number;
}
export interface GrantInfo {
  principalId: string;
  role: Role;
  grantedBy: string;
  grantedAtMs: number;
}
export interface AuditInfo {
  id: number;
  atMs: number;
  actor: string;
  action: string;
  target: string;
  detail: string;
}
export interface TrustInfo {
  tenant: string;
  issuers: string[];
  ledgerKeys: string[];
  anchored: false;
}


/** Hard stop for "load everything" loops, so a misbehaving server cannot keep the page busy forever. */
const MAX_PAGES = 200;

export class AdminApi {
  constructor(
    private readonly base: string,
    private readonly token: () => string | undefined,
    private readonly fetcher: typeof fetch = (...a) => globalThis.fetch(...a),
  ) {}

  async #send(method: string, path: string, body?: unknown): Promise<Response> {
    const token = this.token();
    const res = await this.fetcher(`${this.base}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      let message = `request failed (${res.status})`;
      try {
        const j = (await res.json()) as { error?: unknown };
        if (typeof j.error === "string") message = j.error;
      } catch {
        // not JSON: keep the generic message
      }
      throw new ApiError(res.status, message);
    }
    return res;
  }

  async #json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.#send(method, path, body)).json() as Promise<T>;
  }

  /** Follows `next` until the server stops sending it. */
  async #all<T, K extends string>(path: string, key: K): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const sep = path.includes("?") ? "&" : "?";
      const page = await this.#json<Record<K, T[]> & { next?: string }>("GET", `${path}${after ? `${sep}after=${encodeURIComponent(after)}` : ""}`);
      out.push(...page[key]);
      if (!page.next) return out;
      after = page.next;
    }
    throw new ApiError(0, "too many pages; the list is longer than this console loads");
  }

  me = () => this.#json<{ id: string; email: string; displayName: string; orgRole: string }>("GET", "/v1/me");
  people = () => this.#all<Person, "principals">("/v1/admin/principals?limit=200", "principals");
  certificates = async (id: string) => (await this.#json<{ certificates: CertInfo[] }>("GET", `/v1/admin/principals/${encodeURIComponent(id)}/certificates`)).certificates;
  documents = () => this.#all<DocInfo, "documents">("/v1/admin/documents?limit=200", "documents");
  grants = async (doc: string) => (await this.#json<{ grants: GrantInfo[] }>("GET", `/v1/admin/documents/${encodeURIComponent(doc)}/grants`)).grants;
  async setGrant(doc: string, principalId: string, role: Role): Promise<void> {
    await this.#json("PUT", `/v1/admin/documents/${encodeURIComponent(doc)}/grants/${encodeURIComponent(principalId)}`, { role });
  }
  async removeGrant(doc: string, principalId: string): Promise<void> {
    await this.#json("DELETE", `/v1/admin/documents/${encodeURIComponent(doc)}/grants/${encodeURIComponent(principalId)}`);
  }
  async revoke(serial: string, reason: string): Promise<void> {
    await this.#json("POST", `/v1/certificates/${encodeURIComponent(serial)}/revoke`, { reason });
  }
  disable = async (id: string) => (await this.#json<{ certificatesRevoked: number }>("POST", `/v1/principals/${encodeURIComponent(id)}/disable`)).certificatesRevoked;
  /** The newest `limit` events are what an admin wants first, so this loads all and reverses. */
  audit = async () => (await this.#all<AuditInfo, "events">("/v1/admin/audit?limit=500", "events")).reverse();
  trust = () => this.#json<TrustInfo>("GET", "/v1/admin/ledger/trust");
  async exportText(): Promise<string> {
    return (await this.#send("GET", "/v1/admin/ledger/export")).text();
  }
}
