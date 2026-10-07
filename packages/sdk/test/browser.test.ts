import { existsSync } from "node:fs";
import { createServer as createHttp, type IncomingMessage, type Server } from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFrame } from "@omnisync/protocol";
import { World, fakeControlPlane, sleep, until } from "./harness.js";

const haveChromium = existsSync(chromium.executablePath());

/** A TCP relay in front of the gateway that can cut the network and bring it back: a deterministic "offline". */
class Partition {
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

const body = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let s = "";
    req.on("data", (c: Buffer) => (s += c.toString()));
    req.on("end", () => resolve(s));
  });

describe.skipIf(!haveChromium)("two real browsers through a real gateway", () => {
  let world: World;
  let browser: Browser;
  let http: Server;
  let origin = "";
  let bundle = "";
  let gatewayPort = 0;
  const partitions: Partition[] = [];
  const contexts: BrowserContext[] = [];
  const logs: string[] = [];

  beforeAll(async () => {
    const out = await build({
      entryPoints: [fileURLToPath(new URL("../browser/page.ts", import.meta.url))],
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "chrome120",
      write: false,
      logLevel: "silent",
    });
    bundle = out.outputFiles[0]!.text;
    world = new World();
    browser = await chromium.launch({ args: ["--no-sandbox"] });
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled(contexts.map((c) => c.close()));
    await browser?.close();
    await Promise.allSettled(partitions.map((p) => p.close()));
    await new Promise<void>((r) => (http ? http.close(() => r()) : r()));
    await world?.cleanup();
  });

  /** The page server plus a control-plane double per person; the gateway then admits that page's origin. */
  async function startWeb(people: Record<string, string>): Promise<void> {
    const planes = new Map(Object.entries(people).map(([token, id]) => [`Bearer ${token}`, fakeControlPlane(world, id, { grants: { doc: "write" }, sessionToken: token })]));
    http = createHttp(async (req, res) => {
      const url = req.url ?? "/";
      if (url === "/") return void res.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><meta charset="utf-8"><title>omnisync</title><script src="/bundle.js"></script>');
      if (url === "/bundle.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(bundle);
      const cp = planes.get(String(req.headers.authorization ?? "")) ?? [...planes.values()][0]!;
      const r = await cp(`http://x${url}`, { method: req.method ?? "GET", headers: req.headers as Record<string, string>, ...(req.method === "POST" ? { body: await body(req) } : {}) });
      res.writeHead(r.status, { "content-type": "application/json" }).end(await r.text());
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(http.address() as net.AddressInfo).port}`;
    ({ port: gatewayPort } = await world.start({ allowedOrigins: [origin] }));
  }

  async function newPage(): Promise<{ page: Page; ctx: BrowserContext }> {
    const ctx = await browser.newContext();
    contexts.push(ctx);
    const page = await ctx.newPage();
    page.on("console", (m) => logs.push(m.text()));
    page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
    await page.goto(origin + "/");
    return { page, ctx };
  }

  const state = (p: Page) => p.evaluate(() => (window as unknown as { omni: { state(): never } }).omni.state()) as Promise<{
    text: string;
    data: Record<string, unknown>;
    status: { state: string; mode: string };
    pending: number;
    extractable: boolean;
    errors: string[];
  }>;
  const omni = <A extends unknown[]>(p: Page, fn: string, ...args: A) =>
    p.evaluate(([f, a]) => (window as unknown as { omni: Record<string, (...x: unknown[]) => unknown> }).omni[f as string]!(...(a as unknown[])), [fn, args] as const);

  it(
    "edit, go offline, reload with pending edits, return: both browsers converge, and the key could never be exported",
    async () => {
      const erin = await world.person("erin");
      const frank = await world.person("frank");
      await startWeb({ "erin-session": erin.id, "frank-session": frank.id });
      const aProxy = new Partition(gatewayPort);
      const bProxy = new Partition(gatewayPort);
      partitions.push(aProxy, bProxy);
      const aUrl = `ws://127.0.0.1:${await aProxy.listen()}`;
      const bUrl = `ws://127.0.0.1:${await bProxy.listen()}`;

      const A = await newPage();
      const init = (await omni(A.page, "init")) as { extractable: boolean };
      expect(init.extractable).toBe(false);
      await omni(A.page, "enroll", origin, "erin-session");

      const B = await newPage();
      expect(((await omni(B.page, "init")) as { extractable: boolean }).extractable).toBe(false);
      await omni(B.page, "enroll", origin, "frank-session");

      await omni(A.page, "open", aUrl, "doc");
      await omni(B.page, "open", bUrl, "doc");
      await until(async () => (await state(A.page)).status.state === "online" && (await state(B.page)).status.state === "online", 10_000, "both online").catch(async (e: unknown) => {
        throw new Error(`${(e as Error).message}: A=${JSON.stringify(await state(A.page))} B=${JSON.stringify(await state(B.page))} console=${logs.join(" | ")}`);
      });

      // 1. Online editing.
      await omni(A.page, "insertText", 0, "hello");
      await omni(A.page, "mapSet", [], "title", "Q3");
      await omni(B.page, "mapSet", [], "owner", "frank");
      await until(async () => (await state(B.page)).text === "hello" && (await state(A.page)).data["owner"] === "frank", 10_000, "online convergence");
      await omni(A.page, "synced");
      await omni(B.page, "synced");

      // 2. A loses the network and keeps working; B keeps working online.
      aProxy.cut();
      await until(async () => (await state(A.page)).status.state === "offline", 10_000, "A offline");
      await omni(A.page, "insertText", 5, " offline-A");
      await omni(A.page, "mapSet", [], "rows", [1, 2, 3]);
      await omni(A.page, "flush");
      expect((await state(A.page)).pending).toBe(2);
      await omni(B.page, "insertText", 0, "B:");
      await omni(B.page, "synced");

      // 3. A's tab is reloaded while offline: the pending edits come back from IndexedDB, before any network.
      await A.page.reload();
      expect(((await omni(A.page, "init")) as { extractable: boolean }).extractable).toBe(false);
      const reopened = (await omni(A.page, "open", aUrl, "doc")) as { pending: number; text: string };
      expect(reopened.pending).toBe(2);
      expect(reopened.text).toBe("hello offline-A");
      expect((await state(A.page)).data["rows"]).toEqual([1, 2, 3]);

      // 4. The network returns: everything converges and nothing is duplicated.
      aProxy.restore();
      await omni(A.page, "synced");
      await until(
        async () => {
          const [a, b] = [await state(A.page), await state(B.page)];
          return a.text === b.text && JSON.stringify(a.data, Object.keys(a.data).sort()) === JSON.stringify(b.data, Object.keys(b.data).sort()) && a.text.includes("B:") && a.text.includes("offline-A");
        },
        15_000,
        "convergence after reconnect",
      );
      const a = await state(A.page);
      expect(a.data["rows"]).toEqual([1, 2, 3]);
      expect(a.data["title"]).toBe("Q3");
      expect(a.pending).toBe(0);

      // Five edits in all, each stored exactly once, in order within each page load.
      const rows = await world.store.readUpdates("doc", 0, 100);
      const ids = rows.map((r) => {
        const f = decodeFrame(r.frame);
        return `${f.sessionId}:${f.seq}`;
      });
      expect(new Set(ids).size).toBe(ids.length);
      expect(rows.length).toBe(6);
      expect(world.running[0]!.textOf("doc")).toBe(a.text);

      // 5. The device key: stored, non-extractable, and no export route works.
      for (const p of [A.page, B.page]) {
        const r = (await omni(p, "tryExport")) as { stored: boolean; extractable: boolean; results: Record<string, string> };
        expect(r.stored).toBe(true);
        expect(r.extractable).toBe(false);
        expect(Object.values(r.results).every((v) => v !== "EXPORTED")).toBe(true);
      }
      await sleep(50);
    },
    120_000,
  );
});
