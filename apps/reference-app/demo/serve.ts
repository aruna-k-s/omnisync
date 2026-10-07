/**
 * A demonstration deployment in one process, all in memory: fake IdP, control plane, gateway, the reference app and the
 * console. Nothing is persisted and the IdP signs in anyone: this is for showing the product, never a deployment.
 *
 *   pnpm build (in both apps), then pnpm --filter @omnisync/reference-app demo
 *   http://127.0.0.1:4300/demo/as?u=alice   chooses who signs in next (alice, bob, carol, admin)
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { Stack } from "../../control-plane/test/stack.js";
import type { FakeUser } from "../../control-plane/test/fake-idp.js";

const APP = fileURLToPath(new URL("../dist/", import.meta.url));
const CONSOLE = fileURLToPath(new URL("../../console/dist/", import.meta.url));
for (const d of [APP, CONSOLE]) {
  if (!existsSync(join(d, "index.html"))) {
    console.error(`missing build: ${d}\nrun "pnpm build" first`);
    process.exit(1);
  }
}

const PEOPLE: Record<string, FakeUser> = {
  alice: { sub: "alice-sub", email: "alice@example.com", name: "Alice" },
  bob: { sub: "bob-sub", email: "bob@example.com", name: "Bob" },
  carol: { sub: "carol-sub", email: "carol@example.com", name: "Carol" },
  admin: { sub: "admin-sub", email: "admin@example.com", name: "Admin" },
};
const appPort = Number(process.env["APP_PORT"] ?? 4300);
const consolePort = Number(process.env["CONSOLE_PORT"] ?? 4301);
const appUrl = `http://127.0.0.1:${appPort}/`;
const consoleUrl = `http://127.0.0.1:${consolePort}/`;

const stack = await Stack.start({ appUrls: [appUrl, consoleUrl], adminEmails: [PEOPLE["admin"]!.email] });
stack.idp.user = PEOPLE["alice"]!;

const chooser = (url: URL, res: ServerResponse): boolean => {
  if (url.pathname !== "/demo/as") return false;
  const who = PEOPLE[url.searchParams.get("u") ?? ""];
  if (!who) {
    res.writeHead(400, { "content-type": "text/plain" }).end(`u must be one of: ${Object.keys(PEOPLE).join(", ")}`);
    return true;
  }
  stack.idp.user = who;
  res.writeHead(200, { "content-type": "text/plain" }).end(`the next sign-in is ${who.name} (${who.email})`);
  return true;
};
await stack.serve(APP, appPort, {}, chooser);
await stack.serve(CONSOLE, consolePort, {}, chooser);

process.stdout.write(`reference app  ${appUrl}\nconsole        ${consoleUrl}   (sign in as admin)\nswitch person  ${appUrl}demo/as?u=alice|bob|carol|admin\ncontrol plane  ${stack.cpBase}\n`);
const stop = (): void => void stack.stop().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
