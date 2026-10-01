/**
 * Local demo: starts a gateway, connects two clients with their own keys,
 * edits concurrently and prints the converged text.
 *
 *   pnpm --filter @omnisync/gateway dev            # demo, Yjs
 *   OMNISYNC_ENGINE=loro pnpm --filter @omnisync/gateway dev
 */
import { Keyring, generateKeyPair } from "@omnisync/protocol";
import type { EngineName } from "@omnisync/engine";
import { Gateway } from "./gateway.js";
import { GatewayClient } from "./client.js";

const engine = (process.env.OMNISYNC_ENGINE ?? "yjs") as EngineName;
const keyring = new Keyring();
const alice = generateKeyPair();
const bob = generateKeyPair();
keyring.add(alice.publicKey);
keyring.add(bob.publicKey);

const gateway = new Gateway({ engine, resolveKey: keyring.resolve, port: Number(process.env.PORT ?? 0) });
const port = await gateway.listen();
const url = `ws://127.0.0.1:${port}`;
console.log(`gateway (${engine}) on ${url}`);

const a = await GatewayClient.connect({ url, docId: "demo", actor: 1, key: alice, engine });
const b = await GatewayClient.connect({ url, docId: "demo", actor: 2, key: bob, engine });

await a.insert(0, "Hello from Alice. ");
await b.sync();
await Promise.all([a.insert(a.doc.getText().length, "Alice again."), b.insert(0, "[Bob] ")]);
await new Promise((r) => setTimeout(r, 50));

console.log("alice  :", JSON.stringify(a.doc.getText()));
console.log("bob    :", JSON.stringify(b.doc.getText()));
console.log("gateway:", JSON.stringify(gateway.textOf("demo")));
console.log("stats  :", gateway.stats);

await a.close();
await b.close();
await gateway.close();
