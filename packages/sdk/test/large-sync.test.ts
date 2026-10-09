import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeviceKey, MemoryKeyVault } from "../src/keys.js";
import { OmniSyncClient } from "../src/client.js";
import { MemoryOutbox } from "../src/outbox.js";
import { World, until } from "./harness.js";

const FAST = { batch: { minMs: 5, maxMs: 20 }, backoff: { baseMs: 20, maxMs: 100 }, syncTimeoutMs: 1500 } as const;

/** Ticket L1 (docs/specs/large-sync.md): the SDK must open a document whose state is over 1 MiB. */
describe("SDK: opening a large document", () => {
  let world: World;
  const clients: OmniSyncClient[] = [];
  const CHUNK = 32 * 1024;
  const CHUNKS = 100;

  beforeEach(() => {
    world = new World();
  });
  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((c) => c.close()));
    await world.cleanup();
  });

  async function device(name: string) {
    const key = await createDeviceKey({ vault: new MemoryKeyVault() });
    const principal = await world.person(name);
    const { certificate } = await world.enroll(principal, key, { doc: "write" });
    return { key, certificate };
  }
  function connect(url: string, d: Awaited<ReturnType<typeof device>>, tuning: Record<string, unknown> = {}) {
    const c = new OmniSyncClient({ url, key: d.key, certificate: d.certificate, outbox: () => new MemoryOutbox(), tuning: { ...FAST, ...tuning } });
    clients.push(c);
    return c;
  }

  async function seed(url: string): Promise<string> {
    const writer = await connect(url, await device("writer")).open("doc");
    await writer.online();
    for (let i = 0; i < CHUNKS; i++) {
      writer.insertText(writer.text.length, String.fromCharCode(97 + (i % 26)).repeat(CHUNK));
      if (i % 10 === 9) await writer.synced();
    }
    await writer.synced();
    return writer.text;
  }

  it("a stock SyncDocument syncs it and holds the writer's text", async () => {
    const { url } = await world.start();
    const text = await seed(url);
    expect(text.length).toBe(CHUNK * CHUNKS);
    const reader = await connect(url, await device("reader")).open("doc");
    await reader.online();
    expect(reader.text).toBe(text);
    expect(reader.decodeErrors).toBe(0);
    expect(reader.lastDecodeError).toBeUndefined();
  }, 60_000);

  it("with a smaller maxInboundBytes it does not come online, counts the dropped frames and names the cause", async () => {
    const { url } = await world.start();
    await seed(url);
    const seen: string[] = [];
    const reader = await connect(url, await device("reader2"), { maxInboundBytes: 512 * 1024, onDecodeError: (e: string) => seen.push(e) }).open("doc");
    await until(() => reader.decodeErrors >= 2, 8000, "two dropped SYNC_2 frames across a reconnect");
    expect(reader.status.state).not.toBe("online");
    expect(reader.lastDecodeError).toMatch(/too_large/);
    expect(seen).toHaveLength(reader.decodeErrors);
    expect(seen.every((e) => /too_large/.test(e))).toBe(true);
  }, 60_000);

  it("a decode-error callback that throws does not stop the document counting", async () => {
    const { url } = await world.start();
    await seed(url);
    const reader = await connect(url, await device("reader3"), {
      maxInboundBytes: 512 * 1024,
      onDecodeError: () => {
        throw new Error("observer bug");
      },
    }).open("doc");
    await until(() => reader.decodeErrors >= 2, 8000, "two dropped frames despite the throwing observer");
    expect(reader.errors.filter((e) => e.startsWith("handler:"))).toEqual([]); // the observer's bug stays the observer's
  }, 60_000);

  it("rejects a nonsensical maxInboundBytes when the document is opened", async () => {
    const { url } = await world.start();
    const d = await device("cfg");
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(connect(url, d, { maxInboundBytes: bad }).open("doc")).rejects.toThrow(/maxInboundBytes/);
    }
  });
});
