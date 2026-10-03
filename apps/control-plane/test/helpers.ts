import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { generateKeyPair, type KeyPair } from "@omnisync/protocol";
import { signEnrollmentProof, signerFromKeyPair, trustAnchors } from "@omnisync/crypto";
import { MemoryIdentityStore, type IdentityStore } from "@omnisync/store";
import { FaultyIdentityStore } from "@omnisync/store/testing";
import { createControlPlane, type ControlPlaneConfig } from "../src/index.js";
import { FakeIdp, type FakeUser } from "./fake-idp.js";

export const T0 = 1_800_000_000_000;
export const issuerKey = generateKeyPair(new Uint8Array(32).fill(200));
export const anchors = trustAnchors([issuerKey.publicKey]);

export class Clock {
  constructor(public t = T0) {}
  readonly now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface Plane {
  app: NestFastifyApplication;
  idp: FakeIdp;
  identity: FaultyIdentityStore;
  clock: Clock;
  /** Starts a login and walks the IdP: returns the callback URL and the cookie the same browser holds. */
  begin(): Promise<{ callback: string; cookie: string }>;
  /** Logs `user` in through the fake IdP and returns the session token. */
  login(user: FakeUser): Promise<{ token: string; id: string }>;
  call(token: string | undefined, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown): ReturnType<NestFastifyApplication["inject"]>;
  /** Enrolls a fresh device key for `token`'s owner. */
  enroll(token: string, id: string, key?: KeyPair, lifetimeMs?: number): Promise<{ key: KeyPair; res: Awaited<ReturnType<Plane["call"]>> }>;
  close(): Promise<void>;
}

let seed = 30;

/** The cookie a browser would send back after /v1/auth/login. */
export function cookieOf(res: { headers: Record<string, unknown> }): string {
  const set = res.headers["set-cookie"];
  return String(Array.isArray(set) ? set[0] : set).split(";")[0] as string;
}

export async function startPlane(
  over: Partial<ControlPlaneConfig> = {},
  identity: IdentityStore = new MemoryIdentityStore(),
  clock = new Clock(),
): Promise<Plane> {
  const idp = await new FakeIdp("omnisync-test").start();
  const faulty = new FaultyIdentityStore(identity);
  const redirectUri = "http://localhost:8081/v1/auth/callback";
  const app = await createControlPlane(
    {
      oidc: { issuerUrl: idp.issuer, clientId: idp.clientId, redirectUri, allowInsecureHttp: true },
      issuer: signerFromKeyPair(issuerKey),
      sessionSecret: new Uint8Array(32).fill(9),
      adminEmails: ["Root@Example.com"],
      now: clock.now,
      ...over,
    },
    { identity: faulty },
  );
  const call: Plane["call"] = (token, method, url, payload) =>
    app.inject({ method, url, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}), ...(payload !== undefined ? { payload: payload as object } : {}) });
  return {
    app,
    idp,
    identity: faulty,
    clock,
    call,
    async begin() {
      const start = await app.inject({ method: "GET", url: "/v1/auth/login" });
      return { callback: await idp.browse(start.headers["location"] as string), cookie: cookieOf(start) };
    },
    async login(user) {
      idp.user = user;
      const start = await app.inject({ method: "GET", url: "/v1/auth/login" });
      const callback = await idp.browse(start.headers["location"] as string);
      const res = await app.inject({ method: "GET", url: callback, headers: { cookie: cookieOf(start) } });
      if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
      const body = res.json<{ sessionToken: string; principal: { id: string } }>();
      return { token: body.sessionToken, id: body.principal.id };
    },
    async enroll(token, id, key = generateKeyPair(new Uint8Array(32).fill(seed++)), lifetimeMs) {
      const res = await call(token, "POST", "/v1/certificates", {
        publicKey: Buffer.from(key.publicKey).toString("base64url"),
        proof: Buffer.from(signEnrollmentProof(id, key.publicKey, key.secretKey)).toString("base64url"),
        ...(lifetimeMs !== undefined ? { lifetimeMs } : {}),
      });
      return { key, res };
    },
    async close() {
      await app.close();
      await idp.stop();
    },
  };
}
