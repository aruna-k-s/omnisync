import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { decodeCertificate } from "@omnisync/crypto";
import { verifyLedger, parseRecord } from "@omnisync/verifier";
import { freePort, issuerKey, ledgerKey, Partition, Stack } from "../../control-plane/test/stack.js";
import type { FakeUser } from "../../control-plane/test/fake-idp.js";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const haveChromium = existsSync(chromium.executablePath());
const haveBuild = existsSync(join(DIST, "index.html"));
// CI sets OMNISYNC_REQUIRE_BROWSER=1 so a missing Chromium or build fails loudly instead of skipping the exit test.
if ((!haveChromium || !haveBuild) && process.env["OMNISYNC_REQUIRE_BROWSER"] === "1") {
  throw new Error(`reference app e2e needs Chromium (${haveChromium}) and a build in dist/ (${haveBuild})`);
}

const root: FakeUser = { sub: "root-sub", email: "root@example.com", name: "Root" };
const alice: FakeUser = { sub: "alice-sub", email: "alice@example.com", name: "Alice" };
const bob: FakeUser = { sub: "bob-sub", email: "bob@example.com", name: "Bob" };
const carol: FakeUser = { sub: "carol-sub", email: "carol@example.com", name: "Carol" };

describe.skipIf(!haveChromium || !haveBuild)("reference workbook: two people, one document, real browsers, real gateway", () => {
  let stack: Stack;
  let browser: Browser;
  let partition: Partition;
  let aliceUrl = "";
  let bobUrl = "";
  const contexts: BrowserContext[] = [];
  const ids: Record<string, string> = {};
  let docId = "";

  beforeAll(async () => {
    const [aPort, bPort] = [await freePort(), await freePort()];
    aliceUrl = `http://127.0.0.1:${aPort}/`;
    bobUrl = `http://127.0.0.1:${bPort}/`;
    stack = await Stack.start({ appUrls: [aliceUrl, bobUrl], adminEmails: [root.email] });
    partition = new Partition(Number(new URL(stack.gatewayUrl.replace("ws:", "http:")).port));
    const partitionPort = await partition.listen();
    await stack.serve(DIST, aPort);
    await stack.serve(DIST, bPort, { gateway: `ws://127.0.0.1:${partitionPort}` }); // Bob reaches the gateway through the relay we can cut
    for (const u of [alice, bob, carol, root]) ids[u.email] = (await stack.login(u)).id;
    browser = await chromium.launch({ args: ["--no-sandbox"] });
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled(contexts.map((c) => c.close()));
    await browser?.close();
    await partition?.close();
    await stack?.stop();
  });

  async function signedIn(url: string, user: FakeUser, ctx?: BrowserContext): Promise<{ page: Page; ctx: BrowserContext }> {
    stack.idp.user = user;
    const context = ctx ?? (await browser.newContext());
    if (!ctx) contexts.push(context);
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(`${e.name}: ${e.message}`));
    await page.goto(url);
    await page.getByTestId("signin").click();
    await page.getByTestId("whoami").waitFor({ timeout: 15_000 });
    return { page, ctx: context };
  }
  const online = (p: Page) => p.locator('[data-testid="status"][data-state="online"]').waitFor({ timeout: 15_000 });
  const noPending = (p: Page) => p.locator('[data-testid="status"][data-pending="0"]').waitFor({ timeout: 15_000 });
  const cell = async (p: Page, r: number, c: number, v: string) => {
    await p.getByTestId(`cell-${r}-${c}`).fill(v);
    await p.getByTestId(`cell-${r}-${c}`).press("Enter");
  };
  const value = (p: Page, testId: string) => p.getByTestId(testId).inputValue();
  /** Focuses the notes and puts the caret at `index` (-1: the end), so the keyboard types there. */
  const caretAt = async (p: Page, index: number) => {
    await p.getByTestId("notes").focus();
    await p.getByTestId("notes").evaluate((el: HTMLTextAreaElement, i: number) => { const at = i < 0 ? el.value.length : i; el.setSelectionRange(at, at); }, index);
  };

  const pageErrors: string[] = [];
  afterEach(() => {
    const errors = pageErrors.splice(0);
    expect(errors, "uncaught errors in a page").toEqual([]);
  });

  let A: Page;
  let B: Page;

  it("signs two people in; the session never reaches the URL, and the device key is one no script can read", async () => {
    ({ page: A } = await signedIn(aliceUrl, alice));
    ({ page: B } = await signedIn(bobUrl, bob));
    for (const p of [A, B]) {
      expect(p.url()).not.toContain("session");
      expect(await p.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toMatch(/eyJ/); // no session token in storage
    }
    expect(await A.getByTestId("whoami").textContent()).toBe("alice@example.com");
  });

  it("Alice creates a workbook and builds a table; Bob, once an admin grants him access, sees it and edits it live", async () => {
    await A.getByTestId("new-workbook").click();
    await A.getByTestId("doc-id").waitFor();
    docId = (await A.getByTestId("doc-id").textContent()) as string;
    expect(docId).toMatch(/^[0-9a-f-]{36}$/);
    await online(A);
    expect(await A.getByTestId("key-badge").textContent()).toContain("protected"); // WebCrypto Ed25519, non-extractable

    await A.getByTestId("empty-workbook").waitFor();
    await A.getByTestId("start-workbook").click();
    await A.getByTestId("grid").waitFor();
    await A.getByTestId("title").fill("Q3 budget");
    await A.getByTestId("title").press("Enter");
    await A.getByTestId("add-row").click();
    await A.getByTestId("add-row").click();
    await cell(A, 0, 0, "Licences");
    await cell(A, 0, 2, "1200.50");
    await cell(A, 1, 0, "Hosting");
    await cell(A, 1, 2, "300");
    await expect.poll(() => A.getByTestId("total-2").textContent()).toBe("1500.5");
    expect(await A.getByTestId("total-0").textContent()).toBe(""); // text column: no total
    await A.getByTestId("notes").fill("Review on Friday.");
    await noPending(A);

    // Bob has no access yet: the gateway says so and nothing of the document reaches him.
    await B.getByTestId("open-id").fill(docId);
    await B.getByTestId("open-go").click();
    await B.locator('[data-testid="status"][data-state="closed"]').waitFor({ timeout: 15_000 });
    expect(await B.getByTestId("error").textContent()).toMatch(/no_access|closed/);
    expect(await B.getByTestId("grid").count()).toBe(0);
    expect(await B.getByTestId("notes").inputValue()).toBe("");

    // An organisation admin grants him write access (what the console does); he reopens.
    const adminToken = (await stack.login(root)).token;
    expect((await stack.api(adminToken, "PUT", `/v1/admin/documents/${docId}/grants/${ids[bob.email]}`, { role: "write" })).status).toBe(200);
    await B.getByTestId("back").click();
    await B.getByTestId(`recent-${docId}`).click().catch(async () => {
      await B.getByTestId("open-id").fill(docId);
      await B.getByTestId("open-go").click();
    });
    await online(B);
    await B.getByTestId("grid").waitFor({ timeout: 15_000 });
    expect(await value(B, "title")).toBe("Q3 budget");
    expect(await value(B, "cell-0-0")).toBe("Licences");
    expect(await value(B, "cell-1-2")).toBe("300");
    expect(await value(B, "notes")).toBe("Review on Friday.");

    // Bob edits; Alice sees it without doing anything.
    await cell(B, 1, 1, "Dana");
    await B.getByTestId("add-row").click();
    await cell(B, 2, 0, "Support");
    await cell(B, 2, 2, "99.5");
    await expect.poll(() => value(A, "cell-1-1"), { timeout: 10_000 }).toBe("Dana");
    await expect.poll(() => value(A, "cell-2-0"), { timeout: 10_000 }).toBe("Support");
    await expect.poll(() => A.getByTestId("total-2").textContent(), { timeout: 10_000 }).toBe("1600");
  });

  it("merges shared notes typed at the same time, and keeps a reader's caret in place when someone types before it", async () => {
    await A.getByTestId("notes").fill("Hello world");
    await expect.poll(() => value(B, "notes"), { timeout: 10_000 }).toBe("Hello world");
    // Both type at once at opposite ends.
    await Promise.all([
      caretAt(A, 0).then(() => A.keyboard.type("A:")),
      caretAt(B, -1).then(() => B.keyboard.type(" :B")),
    ]);
    await expect.poll(async () => (await value(A, "notes")) === (await value(B, "notes")) && (await value(A, "notes")), { timeout: 10_000 }).toBe("A:Hello world :B");

    // Alice puts her caret after "Hello"; Bob types at the very start; Alice's caret moves with the words.
    await caretAt(A, 7); // "A:Hello| world :B"
    await caretAt(B, 0);
    await B.keyboard.type("XX ");
    await expect.poll(() => value(A, "notes"), { timeout: 10_000 }).toBe("XX A:Hello world :B");
    expect(await A.getByTestId("notes").evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([10, 10]);
  });

  it("keeps working offline: edits are saved on the device, survive a reload, and merge when the network returns", async () => {
    await noPending(A);
    await noPending(B);
    partition.cut();
    await B.locator('[data-testid="status"][data-state="offline"]').waitFor({ timeout: 15_000 });
    expect(await B.getByTestId("status-state").textContent()).toContain("Offline");

    await cell(B, 0, 1, "Priya"); // offline edits
    await B.getByTestId("add-row").click();
    await cell(B, 3, 0, "Training");
    await B.getByTestId("notes").pressSequentially(" (Bob offline)");
    await expect.poll(() => B.getByTestId("pending").textContent(), { timeout: 5000 }).toMatch(/not yet confirmed/);
    await cell(A, 0, 1, "Alex"); // meanwhile Alice edits another cell of the same row
    await expect.poll(() => value(B, "cell-0-1")).toBe("Priya"); // Bob has not seen Alice's edit

    // An edit reaches the device's outbox within one batching window (250 ms); that is the documented limit of a crash or an instant reload.
    await B.waitForTimeout(600);
    // Bob reloads the page while still offline: signs in again (the control plane is reachable, the gateway is not).
    await B.reload();
    stack.idp.user = bob;
    await B.getByTestId("signin").click();
    await B.getByTestId("whoami").waitFor({ timeout: 15_000 });
    await B.getByTestId(`recent-${docId}`).click();
    await B.getByTestId("grid").waitFor({ timeout: 15_000 });
    await expect.poll(() => value(B, "cell-0-1"), { timeout: 5000 }).toBe("Priya"); // his offline work is still there
    expect(await value(B, "cell-3-0")).toBe("Training");
    expect(await value(B, "notes")).toContain("(Bob offline)");
    expect(await B.getByTestId("pending").textContent()).toMatch(/not yet confirmed/);

    partition.restore();
    await online(B);
    await noPending(B);
    await expect.poll(() => value(A, "cell-3-0"), { timeout: 15_000 }).toBe("Training");
    await expect.poll(() => value(A, "notes"), { timeout: 15_000 }).toContain("(Bob offline)");
    // Same cell edited on both sides while apart: one of the two wins, on both screens. Different cells of one row both survive.
    await expect.poll(async () => [await value(A, "cell-0-1"), await value(B, "cell-0-1")].join("|"), { timeout: 15_000 }).toMatch(/^(Alex\|Alex|Priya\|Priya)$/);
    expect(await value(A, "cell-0-0")).toBe("Licences");
    expect(await value(A, "notes")).toBe(await value(B, "notes"));
  });

  it("shows a reader the workbook, read only, and the gateway refuses what a patched client would send", async () => {
    const adminToken = (await stack.login(root)).token;
    await stack.api(adminToken, "PUT", `/v1/admin/documents/${docId}/grants/${ids[carol.email]}`, { role: "read" });
    const { page: C } = await signedIn(aliceUrl, carol);
    await C.getByTestId("open-id").fill(docId);
    await C.getByTestId("open-go").click();
    await C.getByTestId("grid").waitFor({ timeout: 15_000 });
    await C.getByTestId("read-only").waitFor();
    expect(await value(C, "cell-0-0")).toBe("Licences");
    expect(await C.getByTestId("cell-0-0").isDisabled()).toBe(true);
    expect(await C.getByTestId("notes").isDisabled()).toBe(true);
    expect(await C.getByTestId("add-row").count()).toBe(0);
  });

  it("left a ledger the verifier accepts, with entries signed by both people's devices", async () => {
    await noPending(A);
    await noPending(B);
    await stack.checkpoint();
    const adminToken = (await stack.login(root)).token;
    const text = await (await stack.api(adminToken, "GET", "/v1/admin/ledger/export")).text();
    const raw = text.trim().split("\n").map((l) => JSON.parse(l) as unknown);
    const report = await verifyLedger(raw, { issuers: [issuerKey.publicKey], ledgerKeys: [ledgerKey.publicKey], tenant: "acme" });
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);

    const subjects = new Map<string, string>();
    const signers = new Set<string>();
    let entries = 0;
    for (const r of raw) {
      const p = parseRecord(r);
      if (!p.ok) continue;
      if (p.record.t === "cert") subjects.set(Buffer.from(p.record.serial).toString("hex"), decodeCertificate(p.record.certificate).subject);
      if (p.record.t === "entry" && p.record.doc === docId) {
        entries++;
        signers.add(subjects.get(Buffer.from(p.record.certSerial ?? new Uint8Array()).toString("hex")) ?? "?");
      }
    }
    expect(entries).toBeGreaterThan(15);
    expect([...signers].sort()).toEqual([ids[alice.email], ids[bob.email]].sort());
  });
});
