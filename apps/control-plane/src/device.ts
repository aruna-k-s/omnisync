import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Principal } from "@omnisync/store";
import type { ResolvedConfig } from "./config.js";
import { SessionGuard } from "./http.js";
import { KeyedRateLimiter } from "./rate-limit.js";
import { IdentityService } from "./service.js";
import { CONFIG } from "./tokens.js";

/**
 * Device-code login (docs/specs/device-login.md): a device with no browser asks for a code, a signed-in person approves
 * it, and the device collects a session token once. Off unless `deviceLogin` is configured.
 */
@Controller("v1/auth/device")
export class DeviceController {
  readonly #start: KeyedRateLimiter;
  readonly #decide: KeyedRateLimiter;
  readonly #token: KeyedRateLimiter;

  constructor(
    @Inject(IdentityService) private readonly svc: IdentityService,
    @Inject(CONFIG) private readonly cfg: ResolvedConfig,
  ) {
    this.#start = new KeyedRateLimiter(cfg.loginRateLimit.burst, cfg.loginRateLimit.perMinute, cfg.now);
    this.#decide = new KeyedRateLimiter(cfg.loginRateLimit.burst, cfg.loginRateLimit.perMinute, cfg.now);
    // Polling is meant to be frequent (every five seconds per device); this only stops a flood.
    this.#token = new KeyedRateLimiter(60, 120, cfg.now);
  }

  /** 404 unless configured; every answer is uncacheable. */
  #enabled(reply: FastifyReply): string {
    void reply.header("cache-control", "no-store");
    if (!this.cfg.deviceLogin) throw new NotFoundException("device login not configured");
    return this.cfg.deviceLogin.verificationUrl;
  }

  #limited(limiter: KeyedRateLimiter, key: string, reply: FastifyReply): boolean {
    const wait = limiter.take(key);
    if (wait <= 0) return false;
    void reply.status(429).header("retry-after", String(Math.ceil(wait / 1000))).send({ error: "too many requests" });
    return true;
  }

  @Post()
  @HttpCode(200)
  async start(@Req() req: FastifyRequest, @Res() reply: FastifyReply, @Body() body: unknown): Promise<void> {
    const verificationUri = this.#enabled(reply);
    if (this.#limited(this.#start, req.ip, reply)) return;
    const label = typeof body === "object" && body !== null ? (body as { label?: unknown }).label : undefined;
    const s = await this.svc.startDevice(label);
    const complete = new URL(verificationUri);
    complete.searchParams.set("device", s.userCode);
    void reply.status(200).send({ ...s, verificationUri, verificationUriComplete: complete.toString() });
  }

  @Post("token")
  @HttpCode(200)
  async token(@Req() req: FastifyRequest, @Res() reply: FastifyReply, @Body() body: unknown): Promise<void> {
    this.#enabled(reply);
    if (this.#limited(this.#token, req.ip, reply)) return;
    const code = typeof body === "object" && body !== null ? (body as { deviceCode?: unknown }).deviceCode : undefined;
    const r = await this.svc.pollDevice(code);
    if (r.state === "approved") void reply.status(200).send({ sessionToken: r.sessionToken });
    else if (r.state === "slow_down") void reply.status(400).send({ error: "slow_down", interval: r.intervalS });
    else void reply.status(400).send({ error: r.state });
  }

  @Get(":userCode")
  @UseGuards(SessionGuard)
  async show(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Param("userCode") userCode: string) {
    this.#enabled(reply);
    if (this.#limited(this.#decide, principalOf(req).id, reply)) return undefined;
    return this.svc.describeDevice(userCode);
  }

  @Post(":userCode/approve")
  @UseGuards(SessionGuard)
  @HttpCode(200)
  async approve(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Param("userCode") userCode: string) {
    return this.#decideOn(req, reply, userCode, "approve");
  }

  @Post(":userCode/deny")
  @UseGuards(SessionGuard)
  @HttpCode(200)
  async deny(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Param("userCode") userCode: string) {
    return this.#decideOn(req, reply, userCode, "deny");
  }

  async #decideOn(req: FastifyRequest, reply: FastifyReply, userCode: string, decision: "approve" | "deny") {
    this.#enabled(reply);
    if (this.#limited(this.#decide, principalOf(req).id, reply)) return undefined;
    await this.svc.decideDevice(principalOf(req), userCode, decision);
    return decision === "approve" ? { approved: true } : { denied: true };
  }
}

const principalOf = (req: FastifyRequest): Principal => (req as FastifyRequest & { principal: Principal }).principal;
