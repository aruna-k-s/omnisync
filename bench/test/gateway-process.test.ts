import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayClient } from "@omnisync/gateway";
import { generateKeyPair } from "@omnisync/protocol";
import { GatewayProcess } from "../src/load/gateway-process.js";
import { sampleValue } from "../src/load/scrape.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot(extra: Partial<Parameters<typeof GatewayProcess.start>[0]> = {}) {
  const key = generateKeyPair();
  const dir = await mkdtemp(join(tmpdir(), "omnisync-load-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const gw = await GatewayProcess.start({ engine: "yjs", publicKeys: [Buffer.from(key.publicKey).toString("hex")], store: { kind: "memory" }, objectsDir: dir, ...extra });
  cleanups.push(() => gw.stop());
  return { gw, key };
}

describe("GatewayProcess", () => {
  it("starts the real gateway in another process and serves an edit and a scrape", async () => {
    const { gw, key } = await boot();
    expect(gw.pid).not.toBe(process.pid);
    const c = await GatewayClient.connect({ url: gw.url, docId: "d", actor: 1, key });
    cleanups.push(() => c.close());
    await c.insert(0, "hello");
    const text = await gw.scrape();
    expect(sampleValue(text, "omnisync_updates_total", { outcome: "persisted" })).toBe(1);
    expect(sampleValue(text, "omnisync_connections_active")).toBe(1);
    expect(sampleValue(text, "omnisync_documents_active")).toBe(1);
    expect(sampleValue(text, "omnisync_update_apply_seconds_count", { outcome: "ok" })).toBe(1);
    const stats = await gw.stats();
    expect(stats["persisted"]).toBe(1);
  }, 30_000);

  it("reports memory of its own process, which grows with a resident document", async () => {
    const { gw, key } = await boot();
    const before = await gw.memory();
    expect(before.rss).toBeGreaterThan(10_000_000);
    const c = await GatewayClient.connect({ url: gw.url, docId: "d", actor: 1, key });
    cleanups.push(() => c.close());
    await c.insert(0, "x".repeat(900_000));
    const after = await gw.memory();
    expect(after.heapUsed + after.external).toBeGreaterThan(before.heapUsed + before.external);
  }, 30_000);

  it("stop ends the process", async () => {
    const { gw } = await boot();
    await gw.stop();
    await expect(gw.scrape()).rejects.toThrow();
  }, 30_000);
});
