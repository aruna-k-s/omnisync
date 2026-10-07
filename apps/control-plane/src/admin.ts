import {
  BadRequestException,
  type CanActivate,
  Controller,
  Delete,
  type ExecutionContext,
  ForbiddenException,
  Get,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Put,
  Query,
  Req,
  Res,
  Body,
  UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { bytesToHex } from "@omnisync/protocol";
import type { Principal } from "@omnisync/store";
import type { ResolvedConfig } from "./config.js";
import { SessionGuard } from "./http.js";
import { IdentityService } from "./service.js";
import { CONFIG } from "./tokens.js";

type AuthedRequest = FastifyRequest & { principal?: Principal };
const actorOf = (req: FastifyRequest): Principal => (req as AuthedRequest).principal as Principal;

/** Runs after `SessionGuard`, which loaded the principal from the store for this very request. */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const p = ctx.switchToHttp().getRequest<AuthedRequest>().principal;
    if (!p || p.orgRole !== "admin") throw new ForbiddenException("organisation admin only");
    return true;
  }
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const ID_CURSOR = /^[A-Za-z0-9._:@-]{1,128}$/;
const EVENT_CURSOR = /^[0-9]{1,15}$/;

type Query1 = Record<string, string | string[] | undefined>;

function one(q: Query1, name: string): string | undefined {
  const v = q[name];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new BadRequestException(`${name} must be given once`);
  return v;
}

function limitOf(q: Query1): number {
  const raw = one(q, "limit");
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!/^[0-9]{1,4}$/.test(raw)) throw new BadRequestException("limit must be an integer from 1 to 500");
  const n = Number(raw);
  if (n < 1 || n > MAX_LIMIT) throw new BadRequestException("limit must be an integer from 1 to 500");
  return n;
}

function idCursor(q: Query1): string | undefined {
  const raw = one(q, "after");
  if (raw === undefined) return undefined;
  if (!ID_CURSOR.test(raw)) throw new BadRequestException("after is not a valid cursor");
  return raw;
}

const checkId = (id: string, what: string): string => {
  if (!ID_CURSOR.test(id)) throw new BadRequestException(`invalid ${what}`);
  return id;
};

class ExportTooLarge extends Error {}

/** Organisation-admin API for the console (spec: docs/specs/admin-api.md). */
@Controller("v1/admin")
@UseGuards(SessionGuard, AdminGuard)
export class AdminController {
  /** One export at a time: it is read-only but heavy, and it buffers. */
  #exporting = false;

  constructor(
    @Inject(IdentityService) private readonly svc: IdentityService,
    @Inject(CONFIG) private readonly cfg: ResolvedConfig,
  ) {}

  @Get("principals")
  async principals(@Query() q: Query1) {
    const limit = limitOf(q);
    const rows = await this.svc.store.listPrincipals(idCursor(q), limit);
    return {
      principals: rows.map((p) => ({
        id: p.id,
        email: p.email,
        displayName: p.displayName,
        orgRole: p.orgRole,
        ...(p.disabledAtMs !== undefined ? { disabledAtMs: p.disabledAtMs } : {}),
      })),
      ...(rows.length === limit ? { next: rows[rows.length - 1]?.id } : {}),
    };
  }

  @Get("principals/:id/certificates")
  async certificates(@Param("id") id: string) {
    checkId(id, "principal id");
    if (!(await this.svc.store.getPrincipal(id))) throw new NotFoundException("no such principal");
    const certs = await this.svc.store.listCertificatesOf(id);
    // Identifiers and times only: neither the signed bytes nor the public key leave through here.
    return {
      certificates: certs.map((c) => ({
        serial: bytesToHex(c.serial),
        keyId: bytesToHex(c.keyId),
        issuedAtMs: c.issuedAtMs,
        notBeforeMs: c.notBeforeMs,
        notAfterMs: c.notAfterMs,
        ...(c.revokedAtMs !== undefined ? { revokedAtMs: c.revokedAtMs } : {}),
        ...(c.revokeReason !== undefined ? { revokeReason: c.revokeReason } : {}),
      })),
    };
  }

  @Get("documents")
  async documents(@Query() q: Query1) {
    const limit = limitOf(q);
    const rows = await this.svc.store.listDocumentRecords(idCursor(q), limit);
    return {
      documents: rows.map((d) => ({ id: d.id, createdBy: d.createdBy, createdAtMs: d.createdAtMs })),
      ...(rows.length === limit ? { next: rows[rows.length - 1]?.id } : {}),
    };
  }

  @Get("documents/:id/grants")
  async grants(@Req() req: FastifyRequest, @Param("id") id: string) {
    const grants = await this.svc.listGrants(actorOf(req), id, true);
    return { grants: grants.map((g) => ({ principalId: g.principalId, role: g.role, grantedBy: g.grantedBy, grantedAtMs: g.grantedAtMs })) };
  }

  @Put("documents/:id/grants/:principalId")
  async setGrant(@Req() req: FastifyRequest, @Param("id") id: string, @Param("principalId") principalId: string, @Body() body: Record<string, unknown> | undefined) {
    await this.svc.setGrant(actorOf(req), id, checkId(principalId, "principal id"), body?.["role"], true);
    return { ok: true };
  }

  @Delete("documents/:id/grants/:principalId")
  async removeGrant(@Req() req: FastifyRequest, @Param("id") id: string, @Param("principalId") principalId: string) {
    await this.svc.removeGrant(actorOf(req), id, checkId(principalId, "principal id"), true);
    return { ok: true };
  }

  @Get("audit")
  async audit(@Query() q: Query1) {
    const limit = limitOf(q);
    const raw = one(q, "after");
    if (raw !== undefined && !EVENT_CURSOR.test(raw)) throw new BadRequestException("after must be an event id");
    const events = await this.svc.store.listAudit(raw === undefined ? 0 : Number(raw), limit);
    return {
      events: events.map((e) => ({ id: e.id, atMs: e.atMs, actor: e.actor, action: e.action, target: e.target, detail: e.detail })),
      ...(events.length === limit ? { next: String(events[events.length - 1]?.id) } : {}),
    };
  }

  @Get("ledger/trust")
  trust() {
    const l = this.cfg.ledger;
    if (!l) throw new NotFoundException("ledger not configured");
    // What THIS server holds. A verifier that takes keys and export from the same place proves consistency,
    // not that the server told the truth; hence `anchored: false` (spec: Trust inputs and what a browser may claim).
    return { tenant: l.tenant, issuers: l.issuers.map(bytesToHex), ledgerKeys: l.ledgerKeys.map(bytesToHex), anchored: false };
  }

  @Get("ledger/export")
  async exportLedger(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const l = this.cfg.ledger;
    if (!l) throw new NotFoundException("ledger not configured");
    if (this.#exporting) {
      void reply.header("retry-after", "5");
      throw new HttpException("an export is already running", 429);
    }
    this.#exporting = true;
    try {
      // Written first: if the trace cannot be written the log is not read.
      await this.svc.auditLedgerExport(actorOf(req), l.tenant);
      const chunks: Buffer[] = [];
      let bytes = 0;
      try {
        await l.export(async (line) => {
          const b = Buffer.from(line, "utf8");
          bytes += b.length;
          if (bytes > l.maxExportBytes) throw new ExportTooLarge();
          chunks.push(b);
        });
      } catch (e) {
        if (e instanceof ExportTooLarge) throw new HttpException("export too large; use the export command", 413);
        throw e;
      }
      const name = /^[A-Za-z0-9._-]{1,64}$/.test(l.tenant) ? `${l.tenant}-ledger.ndjson` : "ledger.ndjson";
      void reply
        .header("cache-control", "no-store")
        .header("content-disposition", `attachment; filename="${name}"`)
        .type("application/x-ndjson")
        .send(Buffer.concat(chunks));
    } finally {
      this.#exporting = false;
    }
  }
}
