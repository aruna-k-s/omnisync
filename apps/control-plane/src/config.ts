import type { CertificateSigner } from "@omnisync/crypto";

export interface OidcConfig {
  /** Discovery base, e.g. https://login.example.com/realms/acme */
  issuerUrl: string;
  clientId: string;
  /** Omit for a public client (PKCE only). */
  clientSecret?: string;
  /** Where the IdP sends the browser back: this service's /v1/auth/callback. */
  redirectUri: string;
  scopes?: string;
  /** Allow http:// IdPs. Tests only; production IdPs must be https. */
  allowInsecureHttp?: boolean;
}

/** What the admin console needs to show and download the ledger. The control plane never reads the log itself. */
export interface LedgerAdminConfig {
  tenant: string;
  /** Public keys the verifier should trust for certificates. */
  issuers: readonly Uint8Array[];
  /** Public keys for checkpoints. Never the issuing key. */
  ledgerKeys: readonly Uint8Array[];
  /** Writes the whole-tenant export, line by line (the gateway's `exportLedger`). */
  export(write: (line: string) => Promise<void>): Promise<unknown>;
  /** Largest export served over HTTP (default 64 MiB). Larger ones use the export command. */
  maxExportBytes?: number;
}

export const DEFAULT_MAX_EXPORT_BYTES = 64 * 1024 * 1024;

export interface ControlPlaneConfig {
  oidc: OidcConfig;
  /** Signs certificates. A local key now, a KMS-backed signer later. */
  issuer: CertificateSigner;
  /** At least 32 random bytes; signs session tokens. */
  sessionSecret: Uint8Array;
  sessionTtlMs?: number;
  certDefaultLifetimeMs?: number;
  certMaxLifetimeMs?: number;
  /** Emails that become org admins at login. Compared case-insensitively. */
  adminEmails?: readonly string[];
  /** Clock; injectable for tests. */
  now?: () => number;
  /** Trust X-Forwarded-For from a reverse proxy when deciding the client IP for rate limiting. */
  trustProxy?: boolean;
  /** Login starts allowed per client IP: burst and sustained per minute (default 20 and 20). */
  loginRateLimit?: { burst: number; perMinute: number };
  /**
   * Absolute URLs a single-page app may be sent back to after login, with the session in the URL fragment.
   * Exact match only; `https:` or `http://localhost` / `127.0.0.1`. Empty (default): JSON callback only.
   */
  returnTo?: readonly string[];
  /** Enables the ledger routes of the admin API. */
  ledger?: LedgerAdminConfig;
}

export const HOUR_MS = 3_600_000;

export interface ResolvedConfig {
  oidc: OidcConfig;
  issuer: CertificateSigner;
  sessionSecret: Uint8Array;
  sessionTtlMs: number;
  certDefaultLifetimeMs: number;
  certMaxLifetimeMs: number;
  certMinLifetimeMs: number;
  adminEmails: ReadonlySet<string>;
  now: () => number;
  trustProxy: boolean;
  loginRateLimit: { burst: number; perMinute: number };
  returnTo: ReadonlySet<string>;
  ledger?: LedgerAdminConfig & { maxExportBytes: number };
}

function checkReturnTo(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`returnTo entry is not an absolute URL: ${JSON.stringify(raw)}`);
  }
  const local = u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  if (u.protocol !== "https:" && !local) throw new Error(`returnTo must be https (or http on localhost): ${raw}`);
  if (u.username || u.password) throw new Error(`returnTo must not carry credentials: ${raw}`);
  // The session is appended as a fragment; an entry with its own fragment would be ambiguous.
  if (u.hash || raw.includes("#")) throw new Error(`returnTo must not contain a fragment: ${raw}`);
  return raw;
}

export function resolveConfig(c: ControlPlaneConfig): ResolvedConfig {
  if (c.sessionSecret.length < 32) throw new Error("sessionSecret must be at least 32 bytes");
  const certMaxLifetimeMs = c.certMaxLifetimeMs ?? 24 * HOUR_MS;
  const certDefaultLifetimeMs = Math.min(c.certDefaultLifetimeMs ?? 12 * HOUR_MS, certMaxLifetimeMs);
  return {
    oidc: c.oidc,
    issuer: c.issuer,
    sessionSecret: c.sessionSecret,
    sessionTtlMs: c.sessionTtlMs ?? HOUR_MS,
    certDefaultLifetimeMs,
    certMaxLifetimeMs,
    certMinLifetimeMs: 60_000,
    adminEmails: new Set((c.adminEmails ?? []).map((e) => e.toLowerCase())),
    now: c.now ?? Date.now,
    trustProxy: c.trustProxy ?? false,
    loginRateLimit: c.loginRateLimit ?? { burst: 20, perMinute: 20 },
    returnTo: new Set((c.returnTo ?? []).map(checkReturnTo)),
    ...(c.ledger ? { ledger: { ...c.ledger, maxExportBytes: c.ledger.maxExportBytes ?? DEFAULT_MAX_EXPORT_BYTES } } : {}),
  };
}
