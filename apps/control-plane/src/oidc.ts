import * as client from "openid-client";
import type { OidcConfig } from "./config.js";

export interface OidcIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string;
  /** The IdP vouches that the user controls this address. Required for org-admin matching. */
  readonly emailVerified: boolean;
  readonly name: string;
}

export class OidcError extends Error {
  override readonly name = "OidcError";
  constructor(
    readonly code: "bad_state" | "idp_unavailable" | "token_rejected" | "missing_claims",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** What the HTTP layer needs from an OIDC login. Swappable in tests. */
export interface OidcLogin {
  /** `state` is also set in a cookie by the HTTP layer so only the browser that started the login can finish it. */
  begin(): Promise<{ authorizationUrl: string; state: string }>;
  complete(callbackUrl: URL): Promise<OidcIdentity>;
}

interface Pending {
  readonly verifier: string;
  readonly nonce: string;
  readonly createdAt: number;
}

const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 10_000;

/**
 * Authorization-code flow with PKCE, state and nonce (openid-client does the protocol work;
 * the ID token is verified against the IdP's JWKS). Pending logins live in memory: correct for one
 * replica, and the multi-replica move to PostgreSQL is a roadmap item (docs/specs/identity.md).
 */
export class OpenIdLogin implements OidcLogin {
  #config: client.Configuration | undefined;
  readonly #pending = new Map<string, Pending>();

  constructor(
    private readonly cfg: OidcConfig,
    private readonly now: () => number = Date.now,
  ) {}

  async #discover(): Promise<client.Configuration> {
    if (this.#config) return this.#config;
    try {
      const auth = this.cfg.clientSecret ? client.ClientSecretPost(this.cfg.clientSecret) : client.None();
      this.#config = await client.discovery(
        new URL(this.cfg.issuerUrl),
        this.cfg.clientId,
        undefined,
        auth,
        this.cfg.allowInsecureHttp ? { execute: [client.allowInsecureRequests] } : undefined,
      );
      return this.#config;
    } catch (e) {
      throw new OidcError("idp_unavailable", "OIDC discovery failed", { cause: e });
    }
  }

  async begin(): Promise<{ authorizationUrl: string; state: string }> {
    const config = await this.#discover();
    this.#sweep();
    // Full: drop the oldest pending login rather than lock everyone out (per-IP limiting caps the rate).
    if (this.#pending.size >= MAX_PENDING) this.#pending.delete(this.#pending.keys().next().value as string);
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    this.#pending.set(state, { verifier, nonce, createdAt: this.now() });
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.cfg.redirectUri,
      scope: this.cfg.scopes ?? "openid email profile",
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      nonce,
    });
    return { authorizationUrl: url.href, state };
  }

  async complete(callbackUrl: URL): Promise<OidcIdentity> {
    const state = callbackUrl.searchParams.get("state");
    const pending = state === null ? undefined : this.#pending.get(state);
    // One shot: a state value can never be used twice, and never after its time is up.
    if (state !== null) this.#pending.delete(state);
    if (!pending || this.now() - pending.createdAt > PENDING_TTL_MS) throw new OidcError("bad_state", "unknown or expired login");
    const config = await this.#discover();
    // Rebuild the URL on the configured redirect URI: it is what the IdP was told, and it keeps the
    // request's Host header out of the token exchange.
    const current = new URL(this.cfg.redirectUri);
    current.search = callbackUrl.search;
    let claims;
    try {
      const tokens = await client.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: pending.verifier,
        expectedState: state as string,
        expectedNonce: pending.nonce,
      });
      claims = tokens.claims();
    } catch (e) {
      throw new OidcError("token_rejected", "IdP rejected the login", { cause: e });
    }
    if (!claims || typeof claims.sub !== "string" || typeof claims.email !== "string") {
      throw new OidcError("missing_claims", "ID token lacks sub or email");
    }
    return {
      issuer: claims.iss,
      subject: claims.sub,
      email: claims.email,
      emailVerified: claims.email_verified === true,
      name: typeof claims.name === "string" && claims.name ? claims.name : claims.email,
    };
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  #sweep(): void {
    const cutoff = this.now() - PENDING_TTL_MS;
    for (const [state, p] of this.#pending) if (p.createdAt < cutoff) this.#pending.delete(state);
  }
}
