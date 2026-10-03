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
}

export function resolveConfig(c: ControlPlaneConfig): ResolvedConfig {
  if (c.sessionSecret.length < 32) throw new Error("sessionSecret must be at least 32 bytes");
  const certMaxLifetimeMs = c.certMaxLifetimeMs ?? 7 * 24 * HOUR_MS;
  const certDefaultLifetimeMs = Math.min(c.certDefaultLifetimeMs ?? 24 * HOUR_MS, certMaxLifetimeMs);
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
  };
}
