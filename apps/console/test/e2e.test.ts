import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort, Stack } from "../../control-plane/test/stack.js";
import type { FakeUser } from "../../control-plane/test/fake-idp.js";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const haveChromium = existsSync(chromium.executablePath());
const haveBuild = existsSync(join(DIST, "index.html"));
// CI sets OMNISYNC_REQUIRE_BROWSER=1 so a missing Chromium or build fails loudly instead of skipping the exit test.
if ((!haveChromium || !haveBuild) && process.env["OMNISYNC_REQUIRE_BROWSER"] === "1") {
  throw new Error(`console e2e needs Chromium (${haveChromium}) and a build in dist/ (${haveBuild})`);
}

const root: FakeUser = { sub: "root-sub", email: "root@example.com", name: "Root" };
const alice: FakeUser = { sub: "alice-sub", email: "alice@example.com", name: "Alice" };
const bob: FakeUser = { sub: "bob-sub", email: "bob@example.com", name: "Bob" };
const dave: FakeUser = { sub: "dave-sub", email: "dave@example.com", name: "Dave" };

describe.skipIf(!haveChromium || !haveBuild)("console: SSO login to a verified ledger entry, in a real browser", () => {
  let stack: Stack;
  let browser: Browser;
  let consoleUrl = "";
  const contexts: BrowserContext[] = [];
  const seeded: { aliceId: string; bobId: string; docId: string; serial: string } = {} as never;
  // Short names for what the tests read and change directly, as an operator with database access would.
  const identity = () => stack.identity;
  const idp = () => stack.idp;
  const login = (u: FakeUser) => stack.login(u);
  const api = (token: string, method: string, path: string, body?: unknown) => stack.api(token, method, path, body);

  beforeAll(async () => {
    const webPort = await freePort();
    consoleUrl = `http://127.0.0.1:${webPort}/`;
    stack = await Stack.start({ appUrls: [consoleUrl], adminEmails: [root.email, dave.email] });

    // Alice creates a document, shares it with Bob, and both edit it through the real gateway.
    const a = await login(alice);
    const b = await login(bob);
    seeded.aliceId = a.id;
    seeded.bobId = b.id;
    seeded.docId = ((await (await api(a.token, "POST", "/v1/documents")).json()) as { id: string }).id;
    await api(a.token, "PUT", `/v1/documents/${seeded.docId}/grants/${b.id}`, { role: "write" });
    const ad = await stack.enrollDevice(a, 11);
    const bd = await stack.enrollDevice(b, 12);
    seeded.serial = ad.serial;
    const ac = await stack.connect(ad, seeded.docId, 1);
    const bc = await stack.connect(bd, seeded.docId, 2);
    await ac.insert(0, "Quarterly report. ");
    await bc.insert(18, "Reviewed by Bob.");
    await stack.checkpoint();

    await stack.serve(DIST, webPort);
    browser = await chromium.launch({ args: ["--no-sandbox"] });
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled(contexts.map((c) => c.close()));
    await browser?.close();
    await stack?.stop();
  });

  /** Set CONSOLE_SHOTS=<dir> to keep a screenshot of each view (used for the docs and for a human to look at). */
  const shot = async (page: Page, name: string): Promise<void> => {
    const dir = process.env["CONSOLE_SHOTS"];
    if (dir) await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
  };

  async function openAs(user: FakeUser): Promise<Page> {
    idp().user = user;
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

    stack.tamper = true;
    try {
      await page.getByTestId("verify").click();
      await page.locator('[data-testid="ledger-status"][data-status="failed"]').waitFor({ timeout: 20_000 });
      expect((await page.getByTestId("violation").count()) > 0).toBe(true);
      await shot(page, "ledger-failed");
      expect(await page.getByTestId(`entry-${seeded.docId}-1`).getAttribute("data-verified")).toBe("false");
    } finally {
      stack.tamper = false;
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
    const cert = await identity().getCertificate(new Uint8Array(Buffer.from(seeded.serial, "hex")));
    expect(cert?.revokedAtMs).toBeTypeOf("number");
    expect(cert?.revokeReason).toBe("revoked in console");
    const until = Date.now() + 5000;
    while (stack.clients[0]?.connected && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    expect(stack.clients[0]?.connected).toBe(false);
  });

  it("disables an account in one click, revoking every device, and never offers to disable yourself", async () => {
    const carol: FakeUser = { sub: "carol-sub", email: "carol@example.com", name: "Carol" };
    const c = await login(carol);
    const enrolled = await stack.enrollDevice(c, 77);

    const page = await openAs(root);
    const me = await page.getByTestId("whoami").waitFor({ timeout: 15_000 }).then(() => identity().listPrincipals(undefined, 100));
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
    expect((await identity().getPrincipal(c.id))?.disabledAtMs).toBeTypeOf("number");
    expect((await identity().getCertificate(new Uint8Array(Buffer.from(enrolled.serial, "hex"))))?.revokedAtMs).toBeTypeOf("number");
    // A disabled account's session stops working at once.
    expect((await api(c.token, "GET", "/v1/me")).status).toBe(401);
  });

  it("signs out with a message when the server ends the session", async () => {
    const page = await openAs(dave);
    await page.getByTestId("whoami").waitFor({ timeout: 15_000 });
    const daveId = (await identity().listPrincipals(undefined, 100)).find((p) => p.email === dave.email)?.id as string;
    await identity().disablePrincipal(daveId, Date.now(), { atMs: Date.now(), actor: "system", action: "principal.disable", target: daveId });
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
    await expect.poll(() => identity().roleOf(seeded.docId, seeded.bobId)).toBe("read");
    const audit = (await identity().listAudit(0, 1000)).filter((e) => e.action === "grant.set" && e.target === `${seeded.docId}:${seeded.bobId}`);
    expect(audit[audit.length - 1]).toMatchObject({ detail: "read" });
    expect(audit[audit.length - 1]?.actor).not.toBe(seeded.aliceId); // the org admin, not the document owner

    await page.getByTestId(`role-${seeded.aliceId}`).selectOption("read"); // demoting the only admin is refused too
    await expect.poll(() => page.getByTestId("error").textContent()).toContain("at least one enabled admin");
    expect(await identity().roleOf(seeded.docId, seeded.aliceId)).toBe("admin");
    expect(await page.getByTestId(`role-${seeded.aliceId}`).inputValue()).toBe("admin"); // the page shows the truth, not the attempt

    await page.getByTestId(`remove-${seeded.aliceId}`).click(); // Alice is the only admin
    await expect.poll(() => page.getByTestId("error").textContent()).toContain("at least one enabled admin");
    expect(await identity().roleOf(seeded.docId, seeded.aliceId)).toBe("admin");

    await page.getByTestId("nav-audit").click();
    await page.getByTestId("refresh-audit").click();
    await expect.poll(() => page.locator("table tbody tr").count()).toBeGreaterThan(5);
    expect(await page.locator("tbody").textContent()).toContain("ledger.export");
  });
});
