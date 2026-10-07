import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { decodeCertificate } from "@omnisync/crypto";
import { GatewayClient } from "@omnisync/gateway";
import { verifyLedger, parseRecord } from "@omnisync/verifier";
import { freePort, issuerKey, ledgerKey, Stack } from "../../control-plane/test/stack.js";
import type { FakeUser } from "../../control-plane/test/fake-idp.js";
import { loadKey, loadProfile } from "../src/files.js";

const CLI = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const APP = fileURLToPath(new URL("../../reference-app/dist/", import.meta.url));
const haveChromium = existsSync(chromium.executablePath());
const haveBuilds = existsSync(CLI) && existsSync(join(APP, "index.html"));
if ((!haveChromium || !haveBuilds) && process.env["OMNISYNC_REQUIRE_BROWSER"] === "1") {
  throw new Error(`cli e2e needs Chromium (${haveChromium}) and builds of the cli and the reference app (${haveBuilds})`);
}

const root: FakeUser = { sub: "root-sub", email: "root@example.com", name: "Root" };
const alice: FakeUser = { sub: "alice-sub", email: "alice@example.com", name: "Alice" };

/** Runs the real command in a child process, as a person would in a terminal. */
function cli(args: string[], home: string, extra: Record<string, string> = {}) {
  const proc = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env["PATH"] ?? "", OMNISYNC_HOME: home, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
  proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
  const done = new Promise<number>((resolve) => proc.on("close", (code) => resolve(code ?? -1)));
  return { proc, out: () => out, err: () => err, done };
}

describe.skipIf(!haveChromium || !haveBuilds)("command-line sign-in, approved in a real browser, against the real control plane and gateway", () => {
  let stack: Stack;
  let browser: Browser;
  let appUrl = "";
  const tmp: string[] = [];
  const contexts: BrowserContext[] = [];
  const pageErrors: string[] = [];

  const newHome = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), "omnisync-e2e-"));
    tmp.push(d);
    return join(d, "home");
  };

  beforeAll(async () => {
    const port = await freePort();
    appUrl = `http://127.0.0.1:${port}/`;
    stack = await Stack.start({ appUrls: [appUrl], adminEmails: [root.email], deviceVerificationUrl: appUrl });
    await stack.serve(APP, port);
    browser = await chromium.launch({ args: ["--no-sandbox"] });
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled(contexts.map((c) => c.close()));
    await browser?.close();
    await stack?.stop();
    await Promise.allSettled(tmp.map((d) => rm(d, { recursive: true, force: true })));
  });

  afterEach(() => {
    expect(pageErrors.splice(0), "uncaught errors in a page").toEqual([]);
  });

  /** The person's side: open the link the terminal printed, sign in, and return the page showing the request. */
  async function openLink(link: string, user: FakeUser): Promise<Page> {
    stack.idp.user = user;
    const ctx = await browser.newContext();
    contexts.push(ctx);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => pageErrors.push(`${e.name}: ${e.message}`));
    await page.goto(link);
    await page.getByTestId("device-waiting").waitFor({ timeout: 15_000 }); // not signed in yet: told why
    expect(page.url()).not.toContain("device="); // the code is not left in the address bar
    await page.getByTestId("signin").click();
    await page.getByTestId("device-approval").waitFor({ timeout: 20_000 }); // the code survived the round trip to the IdP
    expect(page.url()).not.toContain("session");
    return page;
  }

  const linkOf = async (run: ReturnType<typeof cli>): Promise<{ link: string; code: string }> => {
    let m: RegExpExecArray | null = null;
    await expect.poll(() => (m = /(http:\/\/127\.0\.0\.1:\d+\/\?device=([A-Z]{4}-[A-Z]{4}))/.exec(run.out())), { timeout: 15_000 }).not.toBeNull();
    const found = m as unknown as RegExpExecArray;
    return { link: found[1] as string, code: found[2] as string };
  };

  it("signs a machine in: the code is approved in the browser, the machine gets a key and a certificate that the gateway accepts and the ledger verifies", async () => {
    const home = await newHome();
    const run = cli(["login", "--server", stack.cpBase, "--gateway", stack.gatewayUrl, "--label", "e2e box"], home);
    const { link, code } = await linkOf(run);
    expect(run.out()).toContain(code);

    const page = await openLink(link, alice);
    expect(await page.getByTestId("device-label").textContent()).toBe("e2e box");
    expect(await page.getByTestId("device-code").textContent()).toBe(code); // the person compares it with the terminal
    await page.getByTestId("device-approve").click();
    await expect.poll(() => page.getByTestId("device-result").textContent(), { timeout: 10_000 }).toContain("Approved");

    expect(await run.done).toBe(0);
    expect(run.out()).toContain("Signed in as alice@example.com");
    expect(run.err()).toBe("");

    // What is on disk: a private key, a profile naming Alice, and nothing that could be used to sign in again.
    const aliceSession = await stack.login(alice);
    const profile = await loadProfile(home);
    expect(profile).toMatchObject({ server: stack.cpBase, gateway: stack.gatewayUrl, principalId: aliceSession.id, email: "alice@example.com" });
    if (process.platform !== "win32") expect((await stat(join(home, "key.json"))).mode & 0o777).toBe(0o600);
    const keyText = await readFile(join(home, "key.json"), "utf8");
    const key = await loadKey(home);
    expect(key).toBeDefined();
    for (const f of ["key.json", "profile.json"]) {
      const text = await readFile(join(home, f), "utf8");
      expect(text).not.toContain(aliceSession.token);
      expect(text).not.toMatch(/sessionToken|deviceCode/);
    }
    expect(run.out() + run.err()).not.toContain(keyText.match(/"secretKey":"([0-9a-f]+)"/)?.[1] ?? "no-secret-found");

    // The command agrees that it is signed in.
    const who = cli(["whoami"], home);
    expect(await who.done).toBe(0);
    expect(who.out()).toContain("alice@example.com");

    // The certificate and key work at the gateway: an edit made with them is accepted and lands in the ledger.
    const docId = ((await (await stack.api(aliceSession.token, "POST", "/v1/documents")).json()) as { id: string }).id;
    const cert = new Uint8Array(Buffer.from((profile as { certificate: string }).certificate, "base64url"));
    const client = await GatewayClient.connect({ url: stack.gatewayUrl, docId, actor: 77, key: key as NonNullable<typeof key>, certificate: cert, reconnect: false });
    stack.clients.push(client);
    await client.insert(0, "written from the command line machine");
    await stack.checkpoint();

    const rootSession = await stack.login(root);
    const text = await (await stack.api(rootSession.token, "GET", "/v1/admin/ledger/export")).text();
    const raw = text.trim().split("\n").map((l) => JSON.parse(l) as unknown);
    const report = await verifyLedger(raw, { issuers: [issuerKey.publicKey], ledgerKeys: [ledgerKey.publicKey], tenant: "acme" });
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    let signedByCli = 0;
    for (const r of raw) {
      const p = parseRecord(r);
      if (p.ok && p.record.t === "entry" && p.record.doc === docId && Buffer.from(p.record.certSerial ?? new Uint8Array()).toString("hex") === (profile as { serial: string }).serial) signedByCli++;
    }
    expect(signedByCli).toBeGreaterThan(0);
    const certRecord = raw.map((r) => parseRecord(r)).find((p) => p.ok && p.record.t === "cert" && Buffer.from(p.record.serial).toString("hex") === (profile as { serial: string }).serial);
    expect(certRecord && certRecord.ok && certRecord.record.t === "cert" ? decodeCertificate(certRecord.record.certificate).subject : "").toBe(aliceSession.id);

    // The audit trail names every step, and never a code.
    const events = (await stack.identity.listAudit(0, 500)).filter((e) => e.action.startsWith("device."));
    expect(events.map((e) => e.action)).toEqual(["device.start", "device.approve", "device.token"]);
    expect(JSON.stringify(events)).not.toContain(code);

    // An admin revokes the machine in one call and the gateway refuses it from then on.
    expect((await stack.api(rootSession.token, "POST", `/v1/certificates/${(profile as { serial: string }).serial}/revoke`, { reason: "lost laptop" })).status).toBe(200);
    await expect(GatewayClient.connect({ url: stack.gatewayUrl, docId, actor: 78, key: key as NonNullable<typeof key>, certificate: cert, reconnect: false })).rejects.toThrow();
  });

  it("a denied request leaves the machine signed out, with no key", async () => {
    const home = await newHome();
    const run = cli(["login", "--server", stack.cpBase, "--label", "denied box"], home);
    const { link } = await linkOf(run);
    const page = await openLink(link, alice);
    expect(await page.getByTestId("device-label").textContent()).toBe("denied box");
    await page.getByTestId("device-deny").click();
    await expect.poll(() => page.getByTestId("device-result").textContent(), { timeout: 10_000 }).toContain("Denied");
    expect(await run.done).toBe(1);
    expect(run.err()).toContain("denied");
    expect(await loadKey(home)).toBeUndefined();
    expect(await loadProfile(home)).toBeUndefined();
    const who = cli(["whoami"], home);
    expect(await who.done).toBe(1);
  });

  it("a link that does not match a live request says so instead of approving anything", async () => {
    stack.idp.user = alice;
    const ctx = await browser.newContext();
    contexts.push(ctx);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => pageErrors.push(`${e.name}: ${e.message}`));
    await page.goto(`${appUrl}?device=BCDF-GHJK`);
    await page.getByTestId("signin").click();
    await page.getByTestId("device-error").waitFor({ timeout: 20_000 });
    expect(await page.getByTestId("device-error").textContent()).toContain("not found");
    expect(await page.getByTestId("device-approve").count()).toBe(0);
    await page.getByTestId("device-close").click();
    await page.getByTestId("new-workbook").waitFor(); // back to the app
  });

  it("a request somebody already decided cannot be decided again from the page", async () => {
    const started = (await (await fetch(`${stack.cpBase}/v1/auth/device`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "taken box" }) })).json()) as { userCode: string; verificationUriComplete: string };
    const first = await stack.login(alice);
    expect((await stack.api(first.token, "POST", `/v1/auth/device/${started.userCode}/approve`)).status).toBe(200);
    const page = await openLink(started.verificationUriComplete, { sub: "bob-sub", email: "bob@example.com", name: "Bob" });
    await page.getByTestId("device-error").waitFor();
    expect(await page.getByTestId("device-error").textContent()).toContain("already decided");
    expect(await page.getByTestId("device-approve").count()).toBe(0);
    expect(await page.getByTestId("device-deny").count()).toBe(0);
  });

  it("Ctrl-C while waiting stops the command cleanly and writes nothing", async () => {
    const home = await newHome();
    const run = cli(["login", "--server", stack.cpBase], home);
    await linkOf(run);
    run.proc.kill("SIGINT");
    expect(await run.done).toBe(1);
    expect(run.err()).toContain("cancelled");
    expect(await loadKey(home)).toBeUndefined();
  });
});
