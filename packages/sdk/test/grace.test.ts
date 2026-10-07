import { afterEach, describe, expect, it } from "vitest";
import { OmniSyncClient } from "../src/client.js";
import { createDeviceKey } from "../src/keys.js";
import { MemoryOutbox } from "../src/outbox.js";
import { HOUR, TestClock, World, until } from "./harness.js";

describe("a certificate that lapsed while the user was offline", () => {
  const clients: OmniSyncClient[] = [];
  let world: World;
  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((c) => c.close()));
    await world.cleanup();
  });

  it("delivers edits made before expiry, upload-only, and reads nothing back; beyond grace the SDK stops", async () => {
    const clock = new TestClock();
    world = new World(clock);
    const { url, gateway } = await world.start({ useTestClock: true });
    const key = await createDeviceKey();
    const alice = await world.person("alice");
    const { certificate } = await world.enroll(alice, key, { doc: "write" }, { lifetimeMs: HOUR });
    const bob = await world.person("bob");
    const bobKey = await createDeviceKey();
    const bobCert = await world.enroll(bob, bobKey, { doc: "write" });

    const tuning = { batch: { minMs: 2, maxMs: 10 }, backoff: { baseMs: 20, maxMs: 100 }, clock: clock.now };
    const ob = new MemoryOutbox();
    const a = new OmniSyncClient({ url, key, certificate, outbox: () => ob, tuning: { ...tuning, autoConnect: false } });
    clients.push(a);
    const offline = await a.open("doc");
    offline.insertText(0, "written offline;");
    await offline.flush();
    await offline.close();

    // Bob writes something Alice must not be sent while her certificate is lapsed.
    const b = new OmniSyncClient({ url, key: bobKey, certificate: bobCert.certificate, outbox: () => new MemoryOutbox(), tuning });
    clients.push(b);
    const bobDoc = await b.open("doc");
    await bobDoc.online();
    bobDoc.insertText(0, "bob;");
    await bobDoc.synced();

    clock.advance(2 * HOUR); // Alice's certificate has lapsed, well inside the 72-hour grace.
    const a2 = new OmniSyncClient({ url, key, certificate, outbox: () => ob, tuning });
    clients.push(a2);
    const doc = await a2.open("doc");
    await doc.synced();
    expect(doc.status).toMatchObject({ state: "online", mode: "upload_only" });
    expect(gateway.textOf("doc")).toContain("written offline;");
    expect(doc.text).toBe("written offline;"); // nothing of Bob's came back
    expect(doc.pending).toBe(0);

    // Past the grace window the SDK will not even try.
    clock.advance(100 * HOUR);
    const a3 = new OmniSyncClient({ url, key, certificate, outbox: () => new MemoryOutbox(), tuning });
    clients.push(a3);
    const late = await a3.open("doc");
    expect(late.status).toMatchObject({ state: "closed", reason: "certificate expired" });
    await until(() => true);
  });
});
