import "reflect-metadata";
import { Module, type DynamicModule } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { IdentityStore } from "@omnisync/store";
import { resolveConfig, type ControlPlaneConfig, type ResolvedConfig } from "./config.js";
import { AdminController, AdminGuard } from "./admin.js";
import { DeviceController } from "./device.js";
import { ApiController, AuthController, ErrorFilter, HealthController, SessionGuard } from "./http.js";
import { OpenIdLogin, type OidcLogin } from "./oidc.js";
import { IdentityService } from "./service.js";
import { CONFIG, IDENTITY, OIDC } from "./tokens.js";

@Module({})
class ControlPlaneModule {
  static register(cfg: ResolvedConfig, identity: IdentityStore, oidc: OidcLogin): DynamicModule {
    return {
      module: ControlPlaneModule,
      controllers: [HealthController, AuthController, DeviceController, ApiController, AdminController],
      providers: [
        { provide: CONFIG, useValue: cfg },
        { provide: IDENTITY, useValue: identity },
        { provide: OIDC, useValue: oidc },
        IdentityService,
        SessionGuard,
        AdminGuard,
      ],
    };
  }
}

export interface ControlPlaneDeps {
  identity: IdentityStore;
  /** Defaults to a real OpenID Connect login against `config.oidc`. */
  oidc?: OidcLogin;
}

/** Builds the HTTP application. Call `.listen(port)` or use `.inject()` in tests. */
export async function createControlPlane(config: ControlPlaneConfig, deps: ControlPlaneDeps): Promise<NestFastifyApplication> {
  const cfg = resolveConfig(config);
  const oidc = deps.oidc ?? new OpenIdLogin(cfg.oidc, cfg.now);
  const app = await NestFactory.create<NestFastifyApplication>(
    ControlPlaneModule.register(cfg, deps.identity, oidc),
    new FastifyAdapter({ bodyLimit: 16 * 1024, trustProxy: fastifyTrustProxy(cfg.trustProxy) }),
    { logger: false },
  );
  app.useGlobalFilters(new ErrorFilter());
  // A console served from another origin may call the API, but only the origins it may be sent back to after login.
  // Bearer tokens, no cookies: credentials are never allowed cross-origin.
  const origins = new Set([...cfg.returnTo].map((u) => new URL(u).origin));
  const fastify = app.getHttpAdapter().getInstance();
  if (origins.size > 0) {
    fastify.addHook("onRequest", async (req, reply) => {
      const origin = req.headers.origin;
      if (typeof origin !== "string" || !origins.has(origin)) return;
      void reply.header("access-control-allow-origin", origin).header("vary", "Origin").header("access-control-expose-headers", "retry-after");
      if (req.method === "OPTIONS" && typeof req.headers["access-control-request-method"] === "string") {
        void reply
          .header("access-control-allow-methods", "GET, POST, PUT, DELETE")
          .header("access-control-allow-headers", "authorization, content-type")
          .header("access-control-max-age", "600")
          .code(204)
          .send();
        return reply;
      }
      return;
    });
  }
  await app.init();
  await fastify.ready();
  return app;
}

/**
 * A hop count becomes a trust function: hop 0 is the socket peer, hop 1 the address before it in X-Forwarded-For, and so on.
 * (Fastify documents a number, but in the version in use it silently trusts nobody, so the function is spelled out.)
 */
function fastifyTrustProxy(t: boolean | number | readonly string[]): boolean | string[] | ((address: string, hop: number) => boolean) {
  if (typeof t === "number") return (_address: string, hop: number) => hop < t;
  return typeof t === "object" ? [...t] : t;
}
