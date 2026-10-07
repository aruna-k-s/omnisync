/**
 * A whole OmniSync deployment in one process, for browser tests: fake IdP, real control plane (listening, with a
 * ledger), real gateway, memory stores, and a static server for a built web app. Test infrastructure only.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import net from "node:net";
import { extname, join, normalize } from "node:path";
import { ledgerSignerFromKeyPair, signEnrollmentProof, signerFromKeyPair } from "@omnisync/crypto";
import { CheckpointWriter, Gateway, GatewayClient, exportLedger } from "@omnisync/gateway";
import { generateKeyPair, type KeyPair } from "@omnisync/protocol";
import { MemoryDocumentStore, MemoryIdentityStore, MemoryObjectStore, type LedgerStore } from "@omnisync/store";
import { createControlPlane } from "../src/index.js";
import { FakeIdp, type FakeUser } from "./fake-idp.js";

export const issuerKey = generateKeyPair(new Uint8Array(32).fill(210));
export const ledgerKey = generateKeyPair(new Uint8Array(32).fill(211));

export const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

export interface StackOptions {
  /** URLs the web apps are served from. They become the control plane's `returnTo` (and so its CORS) and the gateway's allowed origins. */
  appUrls: readonly string[];
  adminEmails: readonly string[];
  /** Turns on device-code login; must be one of `appUrls`. */
  deviceVerificationUrl?: string;
}

export class Stack {
  readonly docs = new MemoryDocumentStore();
  readonly identity = new MemoryIdentityStore();
  readonly idp = new FakeIdp("omnisync-web");
  readonly clients: GatewayClient[] = [];
  readonly #web: Server[] = [];
  /** When set, the control plane's ledger export is rewritten as someone with the database might: one payload hash flipped. */
  tamper = false;
  cpBase = "";
  gatewayUrl = "";
  gateway!: Gateway;
  plane!: Awaited<ReturnType<typeof createControlPlane>>;

  static async start(opts: StackOptions): Promise<Stack> {
    const s = new Stack();
    await s.#start(opts);
    return s;
  }

  async #start(opts: StackOptions): Promise<void> {
    await this.idp.start();
    const cpPort = await freePort();
    this.cpBase = `http://127.0.0.1:${cpPort}`;
    this.plane = await createControlPlane(
      {
        oidc: { issuerUrl: this.idp.issuer, clientId: this.idp.clientId, redirectUri: `${this.cpBase}/v1/auth/callback`, allowInsecureHttp: true },
        issuer: signerFromKeyPair(issuerKey),
        sessionSecret: new Uint8Array(32).fill(9),
        adminEmails: [...opts.adminEmails],
        returnTo: [...opts.appUrls],
        ...(opts.deviceVerificationUrl ? { deviceLogin: { verificationUrl: opts.deviceVerificationUrl } } : {}),
        ledger: {
          tenant: "acme",
          issuers: [issuerKey.publicKey],
          ledgerKeys: [ledgerKey.publicKey],
          export: async (write) => {
            const lines: string[] = [];
            await exportLedger({ docs: this.docs as never, identity: this.identity, tenant: "acme" }, (l) => void lines.push(l));
            if (this.tamper) {
              const i = lines.findIndex((l) => l.startsWith('{"t":"entry"'));
              const rec = JSON.parse(lines[i] as string) as { payloadHash: string };
              rec.payloadHash = (rec.payloadHash.startsWith("00") ? "ff" : "00") + rec.payloadHash.slice(2);
              lines[i] = JSON.stringify(rec) + "\n";
            }
            for (const l of lines) await write(l);
          },
        },
      },
      { identity: this.identity },
    );
    await this.plane.listen(cpPort, "127.0.0.1");
    this.gateway = new Gateway({
      auth: { issuers: [issuerKey.publicKey], identity: this.identity, revocationPollMs: 100 },
      store: this.docs,
      objects: new MemoryObjectStore(),
      sweepMs: 3_600_000,
      allowedOrigins: opts.appUrls.map((u) => new URL(u).origin),
    });
    this.gatewayUrl = `ws://127.0.0.1:${await this.gateway.listen()}`;
  }

  /** What a browser does at the control plane, minus the browser: log `user` in and return the session token. */
  async login(user: FakeUser): Promise<{ token: string; id: string }> {
    this.idp.user = user;
    const start = await fetch(`${this.cpBase}/v1/auth/login`, { redirect: "manual" });
    const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0] as string;
    const back = await this.idp.browse(start.headers.get("location") as string);
    const res = await fetch(`${this.cpBase}${back}`, { headers: { cookie } });
    const j = (await res.json()) as { sessionToken: string; principal: { id: string } };
    return { token: j.sessionToken, id: j.principal.id };
  }

  api(token: string, method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.cpBase}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  /** A device key and certificate for `who`, as the SDK's enroll would obtain them. */
  async enrollDevice(who: { token: string; id: string }, seed = 0): Promise<{ key: KeyPair; cert: Uint8Array; serial: string }> {
    const key = generateKeyPair(new Uint8Array(32).fill(seed || 1 + Math.floor(Math.random() * 200)));
    const res = await this.api(who.token, "POST", "/v1/certificates", {
      publicKey: Buffer.from(key.publicKey).toString("base64url"),
      proof: Buffer.from(signEnrollmentProof(who.id, key.publicKey, key.secretKey)).toString("base64url"),
    });
    const j = (await res.json()) as { certificate: string; serial: string };
    return { key, cert: new Uint8Array(Buffer.from(j.certificate, "base64url")), serial: j.serial };
  }

  async connect(device: { key: KeyPair; cert: Uint8Array }, docId: string, actor: number): Promise<GatewayClient> {
    const c = await GatewayClient.connect({ url: this.gatewayUrl, docId, actor, key: device.key, certificate: device.cert, reconnect: false });
    this.clients.push(c);
    return c;
  }

  /** Signs and stores a checkpoint over everything written so far. */
  async checkpoint(): Promise<void> {
    await new CheckpointWriter({ store: this.docs as unknown as LedgerStore, objects: new MemoryObjectStore(), tenant: "acme", signer: ledgerSignerFromKeyPair(ledgerKey) }).flush();
  }

  /** Serves a built web app. `/config.json` is generated so the app finds this stack. */
  async serve(dist: string, port: number, config: Record<string, unknown> = {}, extra?: (url: URL, res: ServerResponse) => boolean): Promise<void> {
    const web = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0] as string;
      if (extra?.(new URL(req.url ?? "/", "http://localhost"), res)) return;
      if (path === "/config.json") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ controlPlane: this.cpBase, gateway: this.gatewayUrl, ...config }));
      const file = normalize(join(dist, path === "/" ? "index.html" : path));
      if (!file.startsWith(dist) || !existsSync(file)) return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
    });
    await new Promise<void>((r) => web.listen(port, "127.0.0.1", r));
    this.#web.push(web);
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.clients.map((c) => c.close()));
    await Promise.allSettled(this.#web.map((w) => new Promise<void>((r) => w.close(() => r()))));
    await this.gateway?.close();
    await this.plane?.close();
    await this.idp.stop();
  }
}

/** A TCP relay in front of the gateway that can cut the network and bring it back: a deterministic "offline". */
export class Partition {
  readonly #sockets = new Set<net.Socket>();
  #blocked = false;
  readonly server: net.Server;
  constructor(readonly target: number) {
    this.server = net.createServer((client) => {
      if (this.#blocked) return void client.destroy();
      const up = net.connect(target, "127.0.0.1");
      this.#sockets.add(client).add(up);
      client.pipe(up);
      up.pipe(client);
      const done = () => {
        client.destroy();
        up.destroy();
        this.#sockets.delete(client);
        this.#sockets.delete(up);
      };
      client.on("error", done).on("close", done);
      up.on("error", done).on("close", done);
    });
  }
  listen(): Promise<number> {
    return new Promise((resolve) => this.server.listen(0, "127.0.0.1", () => resolve((this.server.address() as net.AddressInfo).port)));
  }
  cut(): void {
    this.#blocked = true;
    for (const s of this.#sockets) s.destroy();
  }
  restore(): void {
    this.#blocked = false;
  }
  close(): Promise<void> {
    this.cut();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
