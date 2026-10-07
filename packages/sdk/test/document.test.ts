import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeFrame } from "@omnisync/protocol";
import { createDeviceKey, MemoryKeyVault, type DeviceKey } from "../src/keys.js";
import { OmniSyncClient } from "../src/client.js";
import { DocumentFaultError, type SyncDocument } from "../src/document.js";
import { MemoryOutbox, type Outbox, type OutboxFrame } from "../src/outbox.js";
import { World, craftFrame, sleep, until } from "./harness.js";

const FAST = { batch: { minMs: 5, maxMs: 20 }, backoff: { baseMs: 20, maxMs: 100 }, syncTimeoutMs: 500 } as const;

describe("SDK documents against a real gateway", () => {
  let world: World;
  const clients: OmniSyncClient[] = [];

  beforeEach(() => {
    world = new World();
  });
  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((c) => c.close()));
    await world.cleanup();
  });

  async function device(name: string, doc = "doc", role: "read" | "write" = "write") {
    const key = await createDeviceKey({ vault: new MemoryKeyVault() });
    const principal = await world.person(name);
    const { certificate, serial } = await world.enroll(principal, key, { [doc]: role });
    return { key, principal, certificate, serial };
  }
  function connect(url: string, d: { key: DeviceKey; certificate: Uint8Array }, outbox?: Outbox, extra: Record<string, unknown> = {}) {
    const c = new OmniSyncClient({ url, key: d.key, certificate: d.certificate, outbox: () => outbox ?? new MemoryOutbox(), tuning: { ...FAST, ...extra } });
    clients.push(c);
    return c;
  }

  it("edits are applied at once, signed with the non-extractable key, stored by the gateway, and acknowledged", async () => {
    const { url, gateway } = await world.start();
    const alice = await device("alice");
    expect(alice.key.extractable).toBe(false);
    const ob = new MemoryOutbox();
    const doc = await connect(url, alice, ob).open("doc");
    await doc.online();
    expect(doc.status).toMatchObject({ state: "online", mode: "full" });

    const before = Date.now();
    doc.insertText(0, "hello");
    expect(doc.text).toBe("hello"); // the UI never waits
    expect(doc.pending).toBe(1);
    await doc.synced();
    expect(doc.pending).toBe(0);
    expect(await ob.pending()).toEqual([]);
    expect(gateway.textOf("doc")).toBe("hello");

    const rows = await world.store.readUpdates("doc", 0, 10);
    expect(rows).toHaveLength(1);
    const f = decodeFrame(rows[0]!.frame);
    expect(f.claimedAtMs).toBeGreaterThanOrEqual(before);
    expect(f.claimedAtMs).toBeLessThanOrEqual(Date.now());
    expect(f.sessionId).toBe(doc.sessionId);
    expect(f.seq).toBe(1);
  });

  it("two devices converge on text and structured data", async () => {
    const { url } = await world.start();
    const a = await (async () => {
      const d = await device("alice");
      return connect(url, d).open("doc");
    })();
    const b = await (async () => {
      const d = await device("bob");
      return connect(url, d).open("doc");
    })();
    await Promise.all([a.online(), b.online()]);
    a.insertText(0, "hi");
    a.mapSet([], "title", "Q3");
    a.mapSet([], "rows", []);
    a.arrayInsert(["rows"], 0, [{ n: 1 }, { n: 2 }]);
    b.mapSet([], "owner", "bob");
    await Promise.all([a.synced(), b.synced()]);
    await until(() => JSON.stringify(sorted(a.data)) === JSON.stringify(sorted(b.data)) && a.text === b.text && "rows" in b.data && "owner" in a.data);
    expect(b.text).toBe("hi");
    expect(b.data["title"]).toBe("Q3");
    expect(b.data["rows"]).toEqual([{ n: 1 }, { n: 2 }]);
    expect(a.data["owner"]).toBe("bob");
  });

  it("a refused edit signs nothing, queues nothing and leaves the document unchanged", async () => {
    const { url } = await world.start();
    const ob = new MemoryOutbox();
    const doc = await connect(url, await device("alice"), ob).open("doc");
    await doc.online();
    expect(() => doc.mapSet(["nope"], "k", 1)).toThrow(RangeError);
    expect(() => doc.mapSet([], "k", Number.NaN)).toThrow(RangeError);
    expect(() => doc.insertText(5, "x")).toThrow(RangeError);
    await doc.flush();
    expect(doc.pending).toBe(0);
    expect(await ob.pending()).toEqual([]);
    expect(await ob.highestSeq(doc.sessionId)).toBe(0);
    expect(doc.text).toBe("");
    expect(doc.data).toEqual({});
  });

  it("offline edits are queued durably, in order, and delivered when the gateway returns", async () => {
    const first = await world.start();
    const alice = await device("alice");
    const ob = new MemoryOutbox();
    const doc = await connect(first.url, alice, ob).open("doc");
    await doc.online();
    doc.insertText(0, "online;");
    await doc.synced();

    await first.gateway.crash();
    await until(() => doc.status.state === "offline", 3000, "offline");
    for (const t of ["a;", "b;", "c;"]) {
      doc.insertText(doc.text.length, t);
      await sleep(30); // separate flushes: three frames
    }
    await doc.flush();
    expect(doc.pending).toBe(3);
    expect((await ob.pending()).map((f) => f.seq)).toEqual([2, 3, 4]);

    const second = await world.start({ port: first.port });
    await doc.synced();
    expect(second.gateway.textOf("doc")).toBe("online;a;b;c;");
    // The gateway log holds them in edit order with no gaps.
    const rows = await world.store.readUpdates("doc", 0, 20);
    expect(rows.map((r) => decodeFrame(r.frame).seq)).toEqual([1, 2, 3, 4]);
    expect(doc.reconnects).toBeGreaterThanOrEqual(1);
  });

  it("a page reload with unacknowledged edits rebuilds them locally, then delivers them under a new session", async () => {
    const { url } = await world.start();
    const alice = await device("alice");
    const ob = new MemoryOutbox();
    const c1 = connect(url, alice, ob, { autoConnect: false });
    const d1 = await c1.open("doc");
    d1.insertText(0, "typed offline;");
    d1.insertText(d1.text.length, "twice;");
    await d1.flush();
    const oldSession = d1.sessionId;
    expect((await ob.pending()).length).toBeGreaterThan(0);
    await d1.close(); // the "reload": the outbox keeps its frames

    const c2 = connect(url, alice, ob);
    const d2 = await c2.open("doc");
    expect(d2.text).toBe("typed offline;twice;"); // visible before any network
    expect(d2.sessionId).not.toBe(oldSession);
    expect(d2.pending).toBeGreaterThan(0);
    d2.insertText(d2.text.length, "after;");
    await d2.synced();
    expect(d2.text).toBe("typed offline;twice;after;");
    const rows = await world.store.readUpdates("doc", 0, 20);
    const ids = rows.map((r) => {
      const f = decodeFrame(r.frame);
      return `${f.sessionId}:${f.seq}`;
    });
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((i) => i.startsWith(`${oldSession}:`))).toHaveLength(2);
  });

  it("reloading while offline still shows the document: the last confirmed copy plus the pending edits", async () => {
    const first = await world.start();
    const alice = await device("alice");
    const ob = new MemoryOutbox();
    const c1 = connect(first.url, alice, ob, { snapshotDelayMs: 600_000 }); // only the "first unconfirmed edit" path may save the copy
    const d1 = await c1.open("doc");
    await d1.online();
    d1.insertText(0, "base text;");
    d1.mapSet([], "title", "Q3");
    await d1.synced();
    await first.gateway.crash(); // the network is gone
    await until(() => d1.status.state === "offline", 3000, "offline");
    d1.insertText(d1.text.length, "typed offline");
    await d1.close(); // the "reload"

    const c2 = connect(first.url, alice, ob, { autoConnect: false });
    const d2 = await c2.open("doc");
    expect(d2.text).toBe("base text;typed offline"); // nothing from the network
    expect(d2.data).toEqual({ title: "Q3" });
    expect(d2.pending).toBe(1);
    expect(d2.status.state).toBe("idle");
  });

  it("an edit is stamped with the time it was made, not the time it was signed or sent", async () => {
    const { url } = await world.start();
    const alice = await device("alice");
    let now = 1_000_000;
    const ob = new MemoryOutbox();
    const doc = await connect(url, alice, ob, { autoConnect: false, clock: () => now, batch: { minMs: 1000, maxMs: 2000 } }).open("doc");
    doc.insertText(0, "a");
    now = 1_000_400;
    doc.insertText(1, "b");
    now = 1_009_000; // the batch is signed long after
    await doc.flush();
    expect((await ob.pending()).map((f) => [f.claimedAtMs, decodeFrame(f.bytes).claimedAtMs])).toEqual([
      [1_000_000, 1_000_000],
      [1_000_400, 1_000_400],
    ]);
  });

  it("refuses a certificate for a different device key and keeps the current one", async () => {
    const { url } = await world.start();
    const alice = await device("alice");
    const mallory = await device("mallory");
    const client = connect(url, alice, new MemoryOutbox());
    const doc = await client.open("doc");
    await doc.online();
    expect(() => client.setCertificate(mallory.certificate)).toThrow(/different device key/);
    doc.insertText(0, "still works");
    await doc.synced();
    expect(doc.status.state).toBe("online");
  });

  it("synced() sends what is waiting in the batching window instead of waiting for it", async () => {
    const { url } = await world.start();
    const doc = await connect(url, await device("alice"), new MemoryOutbox(), { batch: { minMs: 30_000, maxMs: 60_000 } }).open("doc");
    await doc.online();
    doc.insertText(0, "now");
    const started = Date.now();
    await doc.synced();
    expect(Date.now() - started).toBeLessThan(3000);
  }, 15_000);

  it("a local copy never holds an edit the outbox does not (an edit still in the batching window is not in it)", async () => {
    const { url } = await world.start();
    const alice = await device("alice");
    const bob = await device("bob");
    const oa = new MemoryOutbox();
    const a = await connect(url, alice, oa, { batch: { minMs: 60_000, maxMs: 60_000 }, snapshotDelayMs: 20 }).open("doc");
    const b = await connect(url, bob, new MemoryOutbox()).open("doc");
    await Promise.all([a.online(), b.online()]);
    a.insertText(0, "QQ"); // made, not yet signed or stored
    b.insertText(0, "remote");
    await b.synced();
    await until(() => a.text.includes("remote"), 5000, "relay");
    await sleep(150); // the copy would be taken now if it were allowed to
    // "crash": no close, no flush. A new page opens from what the storage holds.
    const after = await connect(url, alice, oa, { autoConnect: false }).open("doc");
    expect(after.text).not.toContain("QQ");
    expect(after.pending).toBe(0);
  });

  it("frames the gateway already stored are answered as duplicates and cleared", async () => {
    const { url } = await world.start();
    const alice = await device("alice");
    const f1 = await craftFrame(alice.key, "doc", 77, 1, Date.now(), "one");
    const first = new MemoryOutbox();
    await first.append([f1]);
    const d1 = await connect(url, alice, first).open("doc");
    await d1.synced();
    expect(await world.store.headSeq("doc")).toBe(1);

    // The same frame again (an ACK that never arrived): stored once, cleared on the duplicate answer.
    const again = new MemoryOutbox();
    await again.append([f1]);
    const d2 = await connect(url, alice, again).open("doc");
    await d2.synced();
    expect(await again.pending()).toEqual([]);
    expect(await world.store.headSeq("doc")).toBe(1);
  });

  it("a frame older than one the gateway already stored (a replay answer) counts as delivered", async () => {
    const { url } = await world.start();
    const alice = await device("alice");
    const later = new MemoryOutbox();
    await later.append([await craftFrame(alice.key, "doc", 88, 2, Date.now(), "two")]);
    const d1 = await connect(url, alice, later).open("doc");
    await d1.synced();

    const stale = new MemoryOutbox();
    await stale.append([await craftFrame(alice.key, "doc", 88, 1, Date.now(), "one")]);
    const d2 = await connect(url, alice, stale).open("doc");
    await d2.synced();
    expect(d2.pending).toBe(0);
    expect(await stale.pending()).toEqual([]);
  });

  it("a revoked certificate closes the document with a reason and keeps the edits for a new certificate", async () => {
    const { url } = await world.start();
    const alice = await device("alice");
    await world.revoke(alice.serial);
    const ob = new MemoryOutbox();
    const client = connect(url, alice, ob);
    const doc = await client.open("doc");
    doc.insertText(0, "keep me");
    await until(() => doc.status.state === "closed", 5000, "closed");
    expect(doc.status.reason).toBeTruthy();
    await expect(doc.online()).rejects.toThrow();
    expect(doc.pending).toBe(1);
    await doc.flush();
    expect(await ob.pending()).toHaveLength(1);

    // A new certificate for the same device key brings the queue home.
    const fresh = await world.enroll(alice.principal, alice.key, { doc: "write" });
    client.setCertificate(fresh.certificate);
    await doc.synced();
    expect(world.running[0]!.textOf("doc")).toBe("keep me");
  });

  it("a read-only role sees the document but its edits are refused for good, without blocking later ones", async () => {
    const { url } = await world.start();
    const writer = await device("writer");
    const reader = await device("reader", "doc", "read");
    const w = await connect(url, writer).open("doc");
    const r = await connect(url, reader).open("doc");
    await Promise.all([w.online(), r.online()]);
    w.insertText(0, "visible");
    await w.synced();
    await until(() => r.text === "visible");
    r.insertText(0, "forged-");
    await r.synced();
    expect(r.refusedEdits).toBe(1);
    expect(w.text).toBe("visible");
    expect(world.running[0]!.textOf("doc")).toBe("visible");
  });

  it("when signing or storage fails after an edit, the document refuses further edits instead of silently diverging", async () => {
    const { url } = await world.start();
    const inner = new MemoryOutbox();
    let fail = false;
    const ob: Outbox = {
      append: (f: readonly OutboxFrame[]) => (fail ? Promise.reject(new Error("quota exceeded")) : inner.append(f)),
      pending: () => inner.pending(),
      ack: (s, q) => inner.ack(s, q),
      highestSeq: (s) => inner.highestSeq(s),
      loadSnapshot: () => inner.loadSnapshot(),
      saveSnapshot: (b) => inner.saveSnapshot(b),
      close: () => inner.close(),
    };
    const doc = await connect(url, await device("alice"), ob).open("doc");
    await doc.online();
    doc.insertText(0, "fine");
    await doc.synced();
    fail = true;
    doc.insertText(4, "lost");
    await doc.flush();
    expect(doc.status.state).toBe("error");
    expect(doc.status.reason).toContain("quota");
    expect(() => doc.insertText(0, "more")).toThrow(DocumentFaultError);
    await expect(doc.synced()).rejects.toBeInstanceOf(Error);
    expect(doc.pending).toBe(0);
  });

  it("a certificate far past its life is not used to connect, and the expiry warning fires beforehand", async () => {
    const { url } = await world.start();
    const key = await createDeviceKey();
    const p = await world.person("carol");
    const { certificate } = await world.enroll(p, key, { doc: "write" }, { lifetimeMs: 1000 });
    let warned = 0;
    const client = new OmniSyncClient({
      url,
      key,
      certificate,
      outbox: () => new MemoryOutbox(),
      tuning: { ...FAST, certificateWarningMs: 500, onCertificateExpiring: () => warned++ },
    });
    clients.push(client);
    const doc = await client.open("doc");
    await doc.online();
    await until(() => warned === 1, 2000, "warning");

    const expired = new OmniSyncClient({
      url,
      key,
      certificate,
      outbox: () => new MemoryOutbox(),
      tuning: { ...FAST, clock: () => Date.now() + 100 * 3_600_000 },
    });
    clients.push(expired);
    const late = await expired.open("doc");
    expect(late.status).toMatchObject({ state: "closed", reason: "certificate expired" });
  });
});

function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sorted(x)]));
  return v;
}

export type { SyncDocument };
