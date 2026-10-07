import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import net from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ledgerSignerFromKeyPair, signEnrollmentProof, signerFromKeyPair } from "@omnisync/crypto";
import { createControlPlane } from "@omnisync/control-plane";
import { CheckpointWriter, Gateway, GatewayClient, exportLedger } from "@omnisync/gateway";
import { generateKeyPair, type KeyPair } from "@omnisync/protocol";
import { MemoryDocumentStore, MemoryIdentityStore, MemoryObjectStore, type LedgerStore } from "@omnisync/store";
import { FakeIdp, type FakeUser } from "../../control-plane/test/fake-idp.js";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const haveChromium = existsSync(chromium.executablePath());
const haveBuild = existsSync(join(DIST, "index.html"));
// CI sets OMNISYNC_REQUIRE_BROWSER=1 so a missing Chromium or build fails loudly instead of skipping the exit test.
if ((!haveChromium || !haveBuild) && process.env["OMNISYNC_REQUIRE_BROWSER"] === "1") {
  throw new Error(`console e2e needs Chromium (${haveChromium}) and a build in dist/ (${haveBuild})`);
}

const issuerKey = generateKeyPair(new Uint8Array(32).fill(210));
const ledgerKey = generateKeyPair(new Uint8Array(32).fill(211));
const root: FakeUser = { sub: "root-sub", email: "root@example.com", name: "Root" };
const alice: FakeUser = { sub: "alice-sub", email: "alice@example.com", name: "Alice" };
const bob: FakeUser = { sub: "bob-sub", email: "bob@example.com", name: "Bob" };
const dave: FakeUser = { sub: "dave-sub", email: "dave@example.com", name: "Dave" };
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

describe.skipIf(!haveChromium || !haveBuild)("console: SSO login to a verified ledger entry, in a real browser", () => {
  const docs = new MemoryDocumentStore();
  const identity = new MemoryIdentityStore();
  const idp = new FakeIdp("omnisync-console");
  let browser: Browser;
  let gateway: Gateway;
  let plane: Awaited<ReturnType<typeof createControlPlane>>;
  let web: Server;
  let cpBase = "";
  let consoleUrl = "";
  let tamper = false;
  const contexts: BrowserContext[] = [];
  const clients: GatewayClient[] = [];
  const seeded: { aliceId: string; bobId: string; docId: string; serial: string; aliceKey: KeyPair; cert: Uint8Array } = {} as never;

  /** What a browser does at the control plane, minus the browser: log `user` in and return the session token. */
  async function login(user: FakeUser): Promise<{ token: string; id: string }> {
    idp.user = user;
    const start = await fetch(`${cpBase}/v1/auth/login`, { redirect: "manual" });
    const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0] as string;
    const back = await idp.browse(start.headers.get("location") as string);
    const res = await fetch(`${cpBase}${back}`, { headers: { cookie } });
    const j = (await res.json()) as { sessionToken: string; principal: { id: string } };
    return { token: j.sessionToken, id: j.principal.id };
  }
  const api = (token: string, method: string, path: string, body?: unknown) =>
    fetch(`${cpBase}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });

  beforeAll(async () => {
    await idp.start();
    const cpPort = await freePort();
    cpBase = `http://127.0.0.1:${cpPort}`;
    const webPort = await freePort();
    consoleUrl = `http://127.0.0.1:${webPort}/`;
    let sourceIdentity = identity;
    plane = await createControlPlane(
      {
        oidc: { issuerUrl: idp.issuer, clientId: idp.clientId, redirectUri: `${cpBase}/v1/auth/callback`, allowInsecureHttp: true },
        issuer: signerFromKeyPair(issuerKey),
        sessionSecret: new Uint8Array(32).fill(9),
        adminEmails: [root.email, dave.email],
        returnTo: [consoleUrl],
        ledger: {
          tenant: "acme",
          issuers: [issuerKey.publicKey],
          ledgerKeys: [ledgerKey.publicKey],
          export: async (write) => {
            const lines: string[] = [];
            await exportLedger({ docs: docs as never, identity: sourceIdentity, tenant: "acme" }, (l) => void lines.push(l));
            if (tamper) {
              // Someone with the database rewrites one stored entry: flip the first byte of an entry's payload hash.
              const i = lines.findIndex((l) => l.startsWith('{"t":"entry"'));
              const rec = JSON.parse(lines[i] as string) as { payloadHash: string };
              rec.payloadHash = (rec.payloadHash.startsWith("00") ? "ff" : "00") + rec.payloadHash.slice(2);
              lines[i] = JSON.stringify(rec) + "\n";
            }
            for (const l of lines) await write(l);
          },
        },
      },
      { identity },
    );
    await plane.listen(cpPort, "127.0.0.1");
    sourceIdentity = identity;

    gateway = new Gateway({ auth: { issuers: [issuerKey.publicKey], identity, revocationPollMs: 100 }, store: docs, objects: new MemoryObjectStore(), sweepMs: 3_600_000 });
    const gwUrl = `ws://127.0.0.1:${await gateway.listen()}`;

    // Alice creates a document, shares it with Bob, and both edit it through the real gateway.
    const a = await login(alice);
    const b = await login(bob);
    seeded.aliceId = a.id;
    seeded.bobId = b.id;
    seeded.docId = ((await (await api(a.token, "POST", "/v1/documents")).json()) as { id: string }).id;
    await api(a.token, "PUT", `/v1/documents/${seeded.docId}/grants/${b.id}`, { role: "write" });
    const enroll = async (who: { token: string; id: string }) => {
      const key = generateKeyPair(new Uint8Array(32).fill(who.id.length + 50 + Math.floor(Math.random() * 100)));
      const res = await api(who.token, "POST", "/v1/certificates", {
        publicKey: Buffer.from(key.publicKey).toString("base64url"),
        proof: Buffer.from(signEnrollmentProof(who.id, key.publicKey, key.secretKey)).toString("base64url"),
      });
      const j = (await res.json()) as { certificate: string; serial: string };
      return { key, cert: new Uint8Array(Buffer.from(j.certificate, "base64url")), serial: j.serial };
    };
    const ad = await enroll(a);
    const bd = await enroll(b);
    seeded.serial = ad.serial;
    for (const [d, actor] of [[ad, 1], [bd, 2]] as const) {
      const c = await GatewayClient.connect({ url: gwUrl, docId: seeded.docId, actor, key: d.key, certificate: d.cert, reconnect: false });
      clients.push(c);
    }
    await clients[0]?.insert(0, "Quarterly report. ");
    await clients[1]?.insert(18, "Reviewed by Bob.");
    await new CheckpointWriter({ store: docs as unknown as LedgerStore, objects: new MemoryObjectStore(), tenant: "acme", signer: ledgerSignerFromKeyPair(ledgerKey) }).flush();

    // The built console, served as static files; config.json points it at this control plane.
    web = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0] as string;
      if (path === "/config.json") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ controlPlane: cpBase }));
      const file = normalize(join(DIST, path === "/" ? "index.html" : path));
      if (!file.startsWith(DIST) || !existsSync(file)) return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
    });
    await new Promise<void>((r) => web.listen(webPort, "127.0.0.1", r));
    browser = await chromium.launch({ args: ["--no-sandbox"] });
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled(contexts.map((c) => c.close()));
    await browser?.close();
    await Promise.allSettled(clients.map((c) => c.close()));
    await new Promise<void>((r) => (web ? web.close(() => r()) : r()));
    await gateway?.close();
    await plane?.close();
    await idp.stop();
  });

  /** Set CONSOLE_SHOTS=<dir> to keep a screenshot of each view (used for the docs and for a human to look at). */
  const shot = async (page: Page, name: string): Promise<void> => {
    const dir = process.env["CONSOLE_SHOTS"];
    if (dir) await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
  };

  async function openAs(user: FakeUser): Promise<Page> {
    idp.user = user;
    const ctx = await browser.newContext();
    contexts.push(ctx);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => { throw e; });
    await page.goto(consoleUrl);
    await page.getByTestId("signin").click();
    return page;
  }

  it("signs an admin in through the IdP and keeps the session out of the URL, history and storage", async () => {
    const page = await openAs(root);
    await expect.poll(() => page.getByTestId("whoami").textContent(), { timeout: 15_000 }).toBe("root@example.com");
    expect(page.url()).toBe(consoleUrl); // fragment gone
    expect(page.url()).not.toContain("session");
    const leaks = await page.evaluate(() => ({
      history: history.length,
      local: JSON.stringify({ ...localStorage }),
      sessionStorage: JSON.stringify({ ...sessionStorage }),
      cookie: document.cookie,
    }));
    expect(leaks.local + leaks.sessionStorage + leaks.cookie).not.toMatch(/eyJ/); // no JWT anywhere
    await page.getByTestId("signout").click();
    await page.getByTestId("signin").waitFor();
  });

  it("refuses a member and says why", async () => {
    const page = await openAs(alice);
    await expect.poll(() => page.getByTestId("notice").textContent(), { timeout: 15_000 }).toContain("not an organisation admin");
    expect(await page.getByTestId("whoami").count()).toBe(0);
  });

  it("shows a verified ledger entry, then shows a rewritten entry as failed", async () => {
    const page = await openAs(root);
    await page.getByTestId("whoami").waitFor({ timeout: 15_000 });
    await page.getByTestId("nav-ledger").click();
    await page.getByTestId("verify").click();

    const status = page.getByTestId("ledger-status");
    await status.waitFor({ timeout: 20_000 });
    expect(await status.getAttribute("data-status")).toBe("consistent");
    expect(await status.textContent()).toContain("Not anchored");
    const first = page.getByTestId(`entry-${seeded.docId}-1`);
    await first.waitFor();
    expect(await first.getAttribute("data-verified")).toBe("true");
    expect(await first.textContent()).toContain(seeded.aliceId); // signed by Alice, named from the certificate in the export
    const second = page.getByTestId(`entry-${seeded.docId}-2`);
    expect(await second.getAttribute("data-verified")).toBe("true");
    expect(await second.textContent()).toContain(seeded.bobId);
    await shot(page, "ledger-consistent");
    expect(await page.getByTestId("ledger-counts").textContent()).toContain("not anchored");
    expect(await page.getByTestId("ledger-counts").textContent()).toMatch(/1 document · 2 entries · 2 certificates · 1 checkpoint · 0 not yet covered/);

    tamper = true;
    try {
      await page.getByTestId("verify").click();
      await page.locator('[data-testid="ledger-status"][data-status="failed"]').waitFor({ timeout: 20_000 });
      expect((await page.getByTestId("violation").count()) > 0).toBe(true);
      await shot(page, "ledger-failed");
      expect(await page.getByTestId(`entry-${seeded.docId}-1`).getAttribute("data-verified")).toBe("false");
    } finally {
      tamper = false;
    }
  });

  it("revokes a device in one click and the gateway cuts it off", async () => {
    const page = await openAs(root);
    await page.getByTestId("whoami").waitFor({ timeout: 15_000 });
    await page.getByTestId(`person-${seeded.aliceId}`).click();
    const revoke = page.getByTestId(`revoke-${seeded.serial}`);
    await revoke.waitFor();
    await shot(page, "people");
    await revoke.click();
    await page.locator(`[data-testid="cert-${seeded.serial}"] [data-state="revoked"]`).waitFor();
    expect(await revoke.count()).toBe(0);
    const cert = await identity.getCertificate(new Uint8Array(Buffer.from(seeded.serial, "hex")));
    expect(cert?.revokedAtMs).toBeTypeOf("number");
    expect(cert?.revokeReason).toBe("revoked in console");
    const until = Date.now() + 5000;
    while (clients[0]?.connected && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    expect(clients[0]?.connected).toBe(false);
  });

  it("disables an account in one click, revoking every device, and never offers to disable yourself", async () => {
    const carol: FakeUser = { sub: "carol-sub", email: "carol@example.com", name: "Carol" };
    const c = await login(carol);
    const key = generateKeyPair(new Uint8Array(32).fill(77));
    const enrolled = (await (
      await api(c.token, "POST", "/v1/certificates", {
        publicKey: Buffer.from(key.publicKey).toString("base64url"),
        proof: Buffer.from(signEnrollmentProof(c.id, key.publicKey, key.secretKey)).toString("base64url"),
      })
    ).json()) as { serial: string };

    const page = await openAs(root);
    const me = await page.getByTestId("whoami").waitFor({ timeout: 15_000 }).then(() => identity.listPrincipals(undefined, 100));
    const rootId = me.find((p) => p.email === root.email)?.id as string;
    await page.getByTestId(`person-${rootId}`).click();
    await page.getByTestId("person-detail").waitFor();
    expect(await page.getByTestId(`disable-${rootId}`).count()).toBe(0);

    await page.getByTestId(`person-${c.id}`).click();
    await page.locator(`[data-testid="cert-${enrolled.serial}"] [data-state="active"]`).waitFor();
    await page.getByTestId(`disable-${c.id}`).click();
    await page.locator(`[data-testid="cert-${enrolled.serial}"] [data-state="revoked"]`).waitFor();
    expect(await page.getByTestId(`person-${c.id}`).textContent()).toContain("disabled");
    expect(await page.getByTestId(`disable-${c.id}`).count()).toBe(0);
    expect((await identity.getPrincipal(c.id))?.disabledAtMs).toBeTypeOf("number");
    expect((await identity.getCertificate(new Uint8Array(Buffer.from(enrolled.serial, "hex"))))?.revokedAtMs).toBeTypeOf("number");
    // A disabled account's session stops working at once.
    expect((await api(c.token, "GET", "/v1/me")).status).toBe(401);
  });

  it("signs out with a message when the server ends the session", async () => {
    const page = await openAs(dave);
    await page.getByTestId("whoami").waitFor({ timeout: 15_000 });
    const daveId = (await identity.listPrincipals(undefined, 100)).find((p) => p.email === dave.email)?.id as string;
    await identity.disablePrincipal(daveId, Date.now(), { atMs: Date.now(), actor: "system", action: "principal.disable", target: daveId });
    await page.getByTestId("nav-audit").click(); // the page loads the trail, gets a 401, and signs out
    await expect.poll(() => page.getByTestId("notice").textContent(), { timeout: 10_000 }).toContain("Your session ended");
    expect(await page.getByTestId("whoami").count()).toBe(0);
    await page.getByTestId("signin").waitFor();
  });

  it("changes a grant from the document page and explains why the last admin cannot be removed", async () => {
    const page = await openAs(root);
    await page.getByTestId("whoami").waitFor({ timeout: 15_000 });
    await page.getByTestId("nav-documents").click();
    await page.getByTestId(`doc-${seeded.docId}`).click();
    await page.getByTestId(`grant-${seeded.aliceId}`).waitFor();

    await shot(page, "documents");
    await page.getByTestId(`role-${seeded.bobId}`).selectOption("read");
    await expect.poll(() => identity.roleOf(seeded.docId, seeded.bobId)).toBe("read");
    const audit = (await identity.listAudit(0, 1000)).filter((e) => e.action === "grant.set" && e.target === `${seeded.docId}:${seeded.bobId}`);
    expect(audit[audit.length - 1]).toMatchObject({ detail: "read" });
    expect(audit[audit.length - 1]?.actor).not.toBe(seeded.aliceId); // the org admin, not the document owner

    await page.getByTestId(`role-${seeded.aliceId}`).selectOption("read"); // demoting the only admin is refused too
    await expect.poll(() => page.getByTestId("error").textContent()).toContain("at least one enabled admin");
    expect(await identity.roleOf(seeded.docId, seeded.aliceId)).toBe("admin");
    expect(await page.getByTestId(`role-${seeded.aliceId}`).inputValue()).toBe("admin"); // the page shows the truth, not the attempt

    await page.getByTestId(`remove-${seeded.aliceId}`).click(); // Alice is the only admin
    await expect.poll(() => page.getByTestId("error").textContent()).toContain("at least one enabled admin");
    expect(await identity.roleOf(seeded.docId, seeded.aliceId)).toBe("admin");

    await page.getByTestId("nav-audit").click();
    await page.getByTestId("refresh-audit").click();
    await expect.poll(() => page.locator("table tbody tr").count()).toBeGreaterThan(5);
    expect(await page.locator("tbody").textContent()).toContain("ledger.export");
  });
});
