import { isIP } from "node:net";
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
  /**
   * Which proxies in front of the control plane to believe about the client address (X-Forwarded-For), which the rate
   * limits are keyed on. A hop count (1 = one proxy, the ingress), or the addresses/CIDR ranges of the proxies. `true`
   * (believe anyone) is deliberately not accepted by `parseTrustProxy`. Default: none, the socket peer is the client.
   */
  trustProxy?: boolean | number | readonly string[];
  /** Login starts allowed per client IP: burst and sustained per minute (default 20 and 20). */
  loginRateLimit?: { burst: number; perMinute: number };
  /**
   * Absolute URLs a single-page app may be sent back to after login, with the session in the URL fragment.
   * Exact match only; `https:` or `http://localhost` / `127.0.0.1`. Empty (default): JSON callback only.
   */
  returnTo?: readonly string[];
  /** Enables the ledger routes of the admin API. */
  ledger?: LedgerAdminConfig;
  /**
   * Enables device-code login (docs/specs/device-login.md). `verificationUrl` is the page where a signed-in person
   * approves a device; it must be one of `returnTo`. Without this the device routes answer 404.
   */
  deviceLogin?: { verificationUrl: string };
}

export const DEVICE_CODE_TTL_MS = 600_000;
export const DEVICE_POLL_INTERVAL_MS = 5000;

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
  trustProxy: boolean | number | readonly string[];
  loginRateLimit: { burst: number; perMinute: number };
  returnTo: ReadonlySet<string>;
  ledger?: LedgerAdminConfig & { maxExportBytes: number };
  deviceLogin?: { verificationUrl: string };
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

/**
 * Reads OMNISYNC_TRUST_PROXY: unset or empty means no proxy is trusted; "1" to "5" is a number of proxy hops; otherwise
 * a comma separated list of proxy addresses or CIDR ranges. Trusting every address (a /0 range, `true`) is refused,
 * because then any client could choose the address its rate limit is counted on. Messages never repeat the value.
 */
export function parseTrustProxy(raw: string | undefined): false | number | string[] {
  const v = (raw ?? "").trim();
  if (v === "" || v === "0") return false;
  const bad = (): never => {
    throw new Error("OMNISYNC_TRUST_PROXY must be a number of proxy hops (1-5) or a comma separated list of proxy addresses or CIDR ranges (a /0 range is refused)");
  };
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    return n >= 1 && n <= 5 ? n : bad();
  }
  const out: string[] = [];
  for (const part of v.split(",")) {
    const item = part.trim();
    const m = /^([0-9a-fA-F:.]+)(?:\/(\d{1,3}))?$/.exec(item);
    const family = m ? isIP(m[1] as string) : 0;
    if (!m || family === 0) return bad();
    if (m[2] !== undefined) {
      const bits = Number(m[2]);
      if (bits < 1 || bits > (family === 4 ? 32 : 128)) return bad();
    }
    out.push(item);
  }
  return out;
}

export function resolveConfig(c: ControlPlaneConfig): ResolvedConfig {
  if (c.sessionSecret.length < 32) throw new Error("sessionSecret must be at least 32 bytes");
  if (c.deviceLogin && !(c.returnTo ?? []).includes(c.deviceLogin.verificationUrl)) {
    throw new Error("deviceLogin.verificationUrl must be one of returnTo (it is a page of a web app this control plane serves with CORS)");
  }
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
    ...(c.deviceLogin ? { deviceLogin: { verificationUrl: c.deviceLogin.verificationUrl } } : {}),
    ...(c.ledger ? { ledger: { ...c.ledger, maxExportBytes: c.ledger.maxExportBytes ?? DEFAULT_MAX_EXPORT_BYTES } } : {}),
  };
}
