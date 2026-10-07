import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { OmniSyncClient } from "../src/client.js";
import { createDeviceKey } from "../src/keys.js";
import { IndexedDbOutbox, MemoryOutbox } from "../src/outbox.js";

describe("client", () => {
  const clients: OmniSyncClient[] = [];
  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((c) => c.close()));
  });

  it("hands back the same open document for the same id", async () => {
    const key = await createDeviceKey();
    const c = new OmniSyncClient({ url: "ws://127.0.0.1:1", key, outbox: () => new MemoryOutbox(), tuning: { autoConnect: false } });
    clients.push(c);
    const a = await c.open("doc");
    expect(await c.open("doc")).toBe(a);
    await a.close();
    expect(await c.open("doc")).not.toBe(a); // closed documents are forgotten
  });

  it("keeps edits in IndexedDB by default, so a reload finds them", async () => {
    const key = await createDeviceKey();
    const c1 = new OmniSyncClient({ url: "ws://127.0.0.1:1", key, tuning: { autoConnect: false, batch: { minMs: 1, maxMs: 5 } } });
    const d1 = await c1.open("doc");
    d1.insertText(0, "survives");
    await d1.close();
    expect(c1.warnings).toEqual([]);
    const c2 = new OmniSyncClient({ url: "ws://127.0.0.1:1", key, tuning: { autoConnect: false } });
    clients.push(c2);
    const d2 = await c2.open("doc");
    expect(d2.text).toBe("survives");
    expect(d2.pending).toBe(1);
  });

  it("says so, and still works, where there is no durable storage", async () => {
    const real = globalThis.indexedDB;
    // @ts-expect-error simulating a private window
    delete globalThis.indexedDB;
    try {
      const key = await createDeviceKey();
      const c = new OmniSyncClient({ url: "ws://127.0.0.1:1", key, tuning: { autoConnect: false } });
      clients.push(c);
      const d = await c.open("doc");
      d.insertText(0, "memory only");
      expect(d.text).toBe("memory only");
      expect(c.warnings.join(" ")).toMatch(/no durable storage/);
    } finally {
      globalThis.indexedDB = real;
    }
    expect(IndexedDbOutbox).toBeDefined();
  });
});
