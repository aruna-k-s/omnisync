import "reflect-metadata";
import { Module, type DynamicModule } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { IdentityStore } from "@omnisync/store";
import { resolveConfig, type ControlPlaneConfig, type ResolvedConfig } from "./config.js";
import { AdminController, AdminGuard } from "./admin.js";
import { ApiController, AuthController, ErrorFilter, HealthController, SessionGuard } from "./http.js";
import { OpenIdLogin, type OidcLogin } from "./oidc.js";
import { IdentityService } from "./service.js";
import { CONFIG, IDENTITY, OIDC } from "./tokens.js";

@Module({})
class ControlPlaneModule {
  static register(cfg: ResolvedConfig, identity: IdentityStore, oidc: OidcLogin): DynamicModule {
    return {
      module: ControlPlaneModule,
      controllers: [HealthController, AuthController, ApiController, AdminController],
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
    new FastifyAdapter({ bodyLimit: 16 * 1024, trustProxy: cfg.trustProxy }),
    { logger: false },
  );
  app.useGlobalFilters(new ErrorFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
