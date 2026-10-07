import {
  BadRequestException,
  Body,
  type CanActivate,
  Controller,
  Delete,
  type ExceptionFilter,
  type ExecutionContext,
  Catch,
  type ArgumentsHost,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Param,
  Post,
  Put,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { StoreUnavailableError, type Principal } from "@omnisync/store";
import type { ResolvedConfig } from "./config.js";
import { OidcError, type OidcLogin } from "./oidc.js";
import { IdentityService, ServiceError } from "./service.js";
import { verifySession } from "./session.js";
import { KeyedRateLimiter } from "./rate-limit.js";
import { CONFIG, OIDC } from "./tokens.js";

type AuthedRequest = FastifyRequest & { principal?: Principal };

/** Requires `Authorization: Bearer <session>`, loads the principal and refuses disabled accounts. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(CONFIG) private readonly cfg: ResolvedConfig,
    @Inject(IdentityService) private readonly svc: IdentityService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException("missing bearer token");
    const id = await verifySession(this.cfg.sessionSecret, token, this.cfg.now());
    if (!id) throw new UnauthorizedException("invalid or expired session");
    const principal = await this.svc.store.getPrincipal(id);
    if (!principal || principal.disabledAtMs !== undefined) throw new UnauthorizedException("invalid or expired session");
    req.principal = principal;
    return true;
  }
}

/** Maps domain and storage errors to HTTP statuses without leaking internals. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = "internal error";
    if (e instanceof HttpException) {
      status = e.getStatus();
      const r = e.getResponse();
      message = typeof r === "string" ? r : ((r as { message?: string }).message ?? e.message);
    } else if (e instanceof ServiceError) {
      status = { forbidden: 403, not_found: 404, bad_request: 400, conflict: 409 }[e.code];
      message = e.message;
    } else if (e instanceof StoreUnavailableError) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      message = "storage unavailable";
    } else if (e instanceof OidcError) {
      status = e.code === "idp_unavailable" ? 502 : 400;
      message = e.code;
    }
    void reply.status(status).send({ error: message });
  }
}

const LOGIN_COOKIE = "omnisync_login";
/** Where a single-page app asked to be sent back to; re-checked against the allowlist at the callback. */
const RETURN_COOKIE = "omnisync_return";

function cookie(name: string, value: string, maxAgeS: number, secure: boolean): string {
  return `${name}=${value}; Path=/v1/auth; Max-Age=${maxAgeS}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}
const loginCookie = (value: string, maxAgeS: number, secure: boolean): string => cookie(LOGIN_COOKIE, value, maxAgeS, secure);

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

const b64url = (v: unknown, bytes: number, what: string): Uint8Array => {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]+$/.test(v)) throw new BadRequestException(`${what} must be base64url`);
  const out = new Uint8Array(Buffer.from(v, "base64url"));
  if (out.length !== bytes) throw new BadRequestException(`${what} must be ${bytes} bytes`);
  return out;
};

const view = (p: Principal) => ({ id: p.id, email: p.email, displayName: p.displayName, orgRole: p.orgRole });
const principalOf = (req: FastifyRequest): Principal => (req as AuthedRequest).principal as Principal;

@Controller()
export class HealthController {
  @Get("healthz")
  health() {
    return { ok: true };
  }
}

@Controller("v1/auth")
export class AuthController {
  private readonly limiter: KeyedRateLimiter;

  constructor(
    @Inject(OIDC) private readonly oidc: OidcLogin,
    @Inject(IdentityService) private readonly svc: IdentityService,
    @Inject(CONFIG) private readonly cfg: ResolvedConfig,
  ) {
    this.limiter = new KeyedRateLimiter(cfg.loginRateLimit.burst, cfg.loginRateLimit.perMinute, cfg.now);
  }

  /** Sends the browser to the company IdP. */
  @Get("login")
  async login(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const returnTo = new URL(req.url, "http://control-plane").searchParams.getAll("return_to");
    if (returnTo.length > 1 || (returnTo.length === 1 && !this.cfg.returnTo.has(returnTo[0] as string))) {
      throw new BadRequestException("return_to is not allowed");
    }
    const wait = this.limiter.take(req.ip);
    if (wait > 0) {
      void reply.status(429).header("retry-after", String(Math.ceil(wait / 1000))).send({ error: "too many login attempts" });
      return;
    }
    const { authorizationUrl, state } = await this.oidc.begin();
    // Only the browser that started this login may finish it: the state is bound to a cookie, so a callback
    // URL handed to someone else (login CSRF) is useless.
    const secure = this.cfg.oidc.redirectUri.startsWith("https:");
    const cookies = [loginCookie(state, 600, secure)];
    if (returnTo[0] !== undefined) cookies.push(cookie(RETURN_COOKIE, encodeURIComponent(returnTo[0]), 600, secure));
    void reply.header("cache-control", "no-store").header("set-cookie", cookies).redirect(authorizationUrl, 302);
  }

  /**
   * The IdP returns here. By default the session token is returned as JSON. A single-page app that started the
   * login with an allowlisted `return_to` is redirected there instead, with the token in the URL fragment, so it
   * reaches the page but no server log or Referer header.
   */
  @Get("callback")
  async callback(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const url = new URL(req.url, "http://control-plane");
    if (url.searchParams.has("error")) throw new BadRequestException("login refused by identity provider");
    const state = url.searchParams.get("state");
    if (state === null || cookieValue(req.headers.cookie, LOGIN_COOKIE) !== state) throw new OidcError("bad_state", "login was not started in this browser");
    const identity = await this.oidc.complete(url);
    const { principal, sessionToken } = await this.svc.login(identity);
    const secure = this.cfg.oidc.redirectUri.startsWith("https:");
    void reply.header("cache-control", "no-store").header("set-cookie", [loginCookie("", 0, secure), cookie(RETURN_COOKIE, "", 0, secure)]);
    // Checked again here: a cookie set from a sibling subdomain must not be able to name a URL of its own.
    const returnTo = decodeCookie(cookieValue(req.headers.cookie, RETURN_COOKIE));
    if (returnTo !== undefined && this.cfg.returnTo.has(returnTo)) {
      void reply.redirect(`${returnTo}#session=${encodeURIComponent(sessionToken)}`, 302);
      return;
    }
    void reply.send({ sessionToken, principal: view(principal) });
  }
}

function decodeCookie(v: string | undefined): string | undefined {
  if (!v) return undefined;
  try {
    return decodeURIComponent(v);
  } catch {
    return undefined;
  }
}

@Controller("v1")
@UseGuards(SessionGuard)
export class ApiController {
  constructor(@Inject(IdentityService) private readonly svc: IdentityService) {}

  @Get("me")
  me(@Req() req: FastifyRequest) {
    return view(principalOf(req));
  }

  @Post("certificates")
  async issue(@Req() req: FastifyRequest, @Body() body: Record<string, unknown>) {
    const lifetimeMs = body["lifetimeMs"];
    if (lifetimeMs !== undefined && (typeof lifetimeMs !== "number" || !Number.isSafeInteger(lifetimeMs))) {
      throw new BadRequestException("lifetimeMs must be an integer");
    }
    const issued = await this.svc.issueCertificate(principalOf(req), {
      publicKey: b64url(body["publicKey"], 32, "publicKey"),
      proof: b64url(body["proof"], 64, "proof"),
      ...(lifetimeMs !== undefined ? { lifetimeMs } : {}),
    });
    return {
      certificate: Buffer.from(issued.certificate).toString("base64url"),
      serial: issued.serial,
      subject: issued.subject,
      notBeforeMs: issued.notBeforeMs,
      notAfterMs: issued.notAfterMs,
    };
  }

  @Post("certificates/:serial/revoke")
  @HttpCode(200)
  async revoke(@Req() req: FastifyRequest, @Param("serial") serial: string, @Body() body: Record<string, unknown> | undefined) {
    const reason = typeof body?.["reason"] === "string" ? body["reason"] : "revoked";
    await this.svc.revokeCertificate(principalOf(req), serial, reason);
    return { revoked: true };
  }

  @Post("principals/:id/disable")
  @HttpCode(200)
  async disable(@Req() req: FastifyRequest, @Param("id") id: string) {
    return { certificatesRevoked: await this.svc.disablePrincipal(principalOf(req), id) };
  }

  @Post("documents")
  async createDocument(@Req() req: FastifyRequest) {
    return { id: await this.svc.createDocument(principalOf(req)) };
  }

  @Get("documents/:id/grants")
  async grants(@Req() req: FastifyRequest, @Param("id") id: string) {
    const grants = await this.svc.listGrants(principalOf(req), id);
    return { grants: grants.map((g) => ({ principalId: g.principalId, role: g.role, grantedBy: g.grantedBy, grantedAtMs: g.grantedAtMs })) };
  }

  @Put("documents/:id/grants/:principalId")
  async setGrant(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Param("principalId") principalId: string,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    await this.svc.setGrant(principalOf(req), id, principalId, body?.["role"]);
    return { ok: true };
  }

  @Delete("documents/:id/grants/:principalId")
  async removeGrant(@Req() req: FastifyRequest, @Param("id") id: string, @Param("principalId") principalId: string) {
    await this.svc.removeGrant(principalOf(req), id, principalId);
    return { ok: true };
  }
}

