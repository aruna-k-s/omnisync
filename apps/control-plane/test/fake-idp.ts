import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";

export interface FakeUser {
  sub: string;
  email: string;
  name?: string;
}

interface Code {
  challenge: string;
  nonce: string;
  redirectUri: string;
  user: FakeUser;
  used: boolean;
}

/**
 * A minimal OpenID Connect provider: discovery, JWKS, authorization (auto-approves the configured
 * user), token endpoint with PKCE S256 verification. Enough for openid-client to run a real flow.
 */
export class FakeIdp {
  readonly codes = new Map<string, Code>();
  /** The person who "logs in" next. */
  user: FakeUser = { sub: "alice-sub", email: "alice@example.com", name: "Alice" };
  /** Break the ID token on purpose. */
  tamper: { nonce?: string; audience?: string; issuer?: string } = {};
  /** Claim value for email_verified in the next ID tokens. */
  emailVerified = true;
  tokenRequests = 0;
  #server: Server | undefined;
  #key: Awaited<ReturnType<typeof generateKeyPair>> | undefined;
  #jwk: JWK | undefined;
  issuer = "";

  constructor(readonly clientId: string) {}

  async start(): Promise<this> {
    this.#key = await generateKeyPair("ES256");
    this.#jwk = { ...(await exportJWK(this.#key.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((r) => (this.#server as Server).listen(0, "127.0.0.1", r));
    const addr = (this.#server as Server).address();
    if (addr === null || typeof addr === "string") throw new Error("bind failed");
    this.issuer = `http://127.0.0.1:${addr.port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r()));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["ES256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/jwks") return json(200, { keys: [this.#jwk] });
    if (url.pathname === "/authorize") {
      const p = url.searchParams;
      if (p.get("client_id") !== this.clientId || p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256") {
        return json(400, { error: "invalid_request" });
      }
      const code = randomBytes(16).toString("hex");
      this.codes.set(code, {
        challenge: p.get("code_challenge") ?? "",
        nonce: p.get("nonce") ?? "",
        redirectUri: p.get("redirect_uri") ?? "",
        user: this.user,
        used: false,
      });
      const back = new URL(p.get("redirect_uri") ?? "");
      back.searchParams.set("code", code);
      back.searchParams.set("state", p.get("state") ?? "");
      back.searchParams.set("iss", this.issuer);
      res.writeHead(302, { location: back.href }).end();
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      this.tokenRequests++;
      const body = new URLSearchParams(await readBody(req));
      const entry = this.codes.get(body.get("code") ?? "");
      if (!entry || entry.used) return json(400, { error: "invalid_grant" });
      entry.used = true;
      const verifier = body.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (challenge !== entry.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE mismatch" });
      if (body.get("redirect_uri") !== entry.redirectUri) return json(400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
      const idToken = await new SignJWT({
        email: entry.user.email,
        name: entry.user.name,
        email_verified: this.emailVerified,
        nonce: this.tamper.nonce ?? entry.nonce,
      })
        .setProtectedHeader({ alg: "ES256", kid: "k1" })
        .setIssuer(this.tamper.issuer ?? this.issuer)
        .setSubject(entry.user.sub)
        .setAudience(this.tamper.audience ?? this.clientId)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign((this.#key as Awaited<ReturnType<typeof generateKeyPair>>).privateKey);
      return json(200, { access_token: randomBytes(8).toString("hex"), token_type: "Bearer", expires_in: 300, id_token: idToken });
    }
    res.writeHead(404).end();
  }

  /** Walks the browser's part of the flow: follow the login redirect, return the callback path to hit. */
  async browse(authorizationUrl: string): Promise<string> {
    const r = await fetch(authorizationUrl, { redirect: "manual" });
    const location = r.headers.get("location");
    if (r.status !== 302 || !location) throw new Error(`IdP did not redirect: ${r.status}`);
    const back = new URL(location);
    return `${back.pathname}${back.search}`;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
