import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPair } from "@omnisync/protocol";
import { checkpointHash, signCheckpoint, entryHash, hashBytes, ledgerSignerFromKeyPair, checkpointObjectKey, ZERO_HASH } from "@omnisync/crypto";
import { MemoryObjectStore, type LedgerStore, type PgDocumentStore } from "@omnisync/store";
import { FaultyObjectStore } from "@omnisync/store/testing";
import { verifyLedger, type Report, type TrustInputs } from "@omnisync/verifier";
import { CheckpointWriter, exportLedger, type GatewayClient } from "../src/index.js";
import { HOUR, PG_URL, T0, TestClock, TestIdentity, connectAs, issuerKey, ledgerKey, makeWorld, startGateway, until, type Running, type StoreKind, type World } from "./harness.js";

const kinds: StoreKind[] = PG_URL ? ["memory", "postgres"] : ["memory"];
const trust: TrustInputs = { issuers: [issuerKey.publicKey], ledgerKeys: [ledgerKey.publicKey] };
const signer = ledgerSignerFromKeyPair(ledgerKey);

describe.each(kinds)("ledger end to end on %s store", (kind) => {
  let world: World;
  let clock: TestClock;
  let ids: TestIdentity;
  const running: Running[] = [];
  const clients: GatewayClient[] = [];
  const checkpointObjects = new MemoryObjectStore();

  const setup = async () => {
    world = await makeWorld(kind);
    clock = new TestClock();
    ids = new TestIdentity(world.identity, clock);
  };
  const start = async () => {
    const r = await startGateway(world, { auth: { issuers: [issuerKey.publicKey], identity: world.identity, now: clock.now, revocationPollMs: 3_600_000 } });
    running.push(r);
    return r;
  };
  const writer = (over: Partial<ConstructorParameters<typeof CheckpointWriter>[0]> = {}) =>
    new CheckpointWriter({ store: world.rawStore as unknown as LedgerStore, objects: checkpointObjects, tenant: "acme", signer, now: clock.now, ...over });
  const exportLines = async (): Promise<unknown[]> => {
    const lines: string[] = [];
    await exportLedger(
      { docs: world.rawStore as never, identity: world.identity, tenant: "acme", now: clock.now },
      (l) => void lines.push(l),
    );
    return lines.map((l) => JSON.parse(l) as unknown);
  };
  const lockedCopies = async (n: number): Promise<Map<number, Uint8Array>> => {
    const m = new Map<number, Uint8Array>();
    for (let i = 1; i <= n; i++) {
      const b = await checkpointObjects.get(checkpointObjectKey("acme", i));
      if (b) m.set(i, b);
    }
    return m;
  };

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    for (const r of running.splice(0)) await r.gateway.close().catch(() => {});
    await world?.cleanup();
    checkpointObjects.objects.clear();
  });

  /** Two people edit two documents through the real gateway. */
  async function edit(): Promise<{ alice: Awaited<ReturnType<TestIdentity["enroll"]>>; bob: Awaited<ReturnType<TestIdentity["enroll"]>>; r: Running }> {
    const alice = await ids.enroll("alice", { "doc-1": "write", "doc-2": "write" });
    const bob = await ids.enroll("bob", { "doc-1": "write" });
    const r = await start();
    const a1 = await connectAs(r.url, alice, clock, { docId: "doc-1" });
    const b1 = await connectAs(r.url, bob, clock, { docId: "doc-1" });
    const a2 = await connectAs(r.url, alice, clock, { docId: "doc-2" });
    clients.push(a1, b1, a2);
    clock.advance(1000);
    await a1.insert(0, "hello ");
    clock.advance(1000);
    await b1.insert(0, "[bob] ");
    clock.advance(1000);
    await a2.insert(0, "second doc");
    clock.advance(1000);
    await a1.insert(0, "again ");
    return { alice, bob, r };
  }

  it("real edits export, checkpoint and verify offline; chain fields come from the gateway", async () => {
    await setup();
    await edit();
    const w = writer();
    expect(await w.flush()).toBe(1);

    const lines = await exportLines();
    const report = await verifyLedger(lines, trust, { locked: await lockedCopies(1) });
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.counts).toMatchObject({ documents: 2, entries: 4, certificates: 2, checkpoints: 1, erased: 0, entriesAfterLastCheckpoint: 0 });

    const rows = await world.rawStore.readUpdates("doc-1", 0, 10);
    expect(rows.map((r) => r.receivedAtMs)).toEqual([T0 + 1000, T0 + 2000, T0 + 4000]); // the gateway's clock, one reading per commit
    expect(rows[0]?.certSerial).toBeDefined();
  });

  it("verifies the entries written after the last checkpoint as unattested, then covers them on the next flush", async () => {
    await setup();
    const { alice } = await edit();
    const w = writer();
    await w.flush();
    const c = clients[0] as GatewayClient;
    clock.advance(1000);
    await c.insert(0, "more ");
    let r: Report = await verifyLedger(await exportLines(), trust);
    expect(r.ok).toBe(true);
    expect(r.counts.entriesAfterLastCheckpoint).toBe(1);
    expect(await w.flush()).toBe(1);
    r = await verifyLedger(await exportLines(), trust, { locked: await lockedCopies(2) });
    expect(r.ok).toBe(true);
    expect(r.counts).toMatchObject({ checkpoints: 2, entriesAfterLastCheckpoint: 0 });
    void alice;
  });

  it("the ledger records when the gateway received an edit, not when a slow commit finished", async () => {
    await setup();
    const alice = await ids.enroll("alice", { "doc-1": "write" });
    const r = await start();
    const c = await connectAs(r.url, alice, clock, { docId: "doc-1" });
    clients.push(c);
    clock.advance(1000);
    const arrival = clock.now();
    world.store.delayMs = 300;
    const pending = c.insert(0, "slow");
    await new Promise((res) => setTimeout(res, 100)); // the frame has arrived and is waiting on the database
    clock.advance(HOUR);
    await pending;
    world.store.delayMs = 0;
    const rows = await world.rawStore.readUpdates("doc-1", 0, 10);
    expect(rows.map((x) => x.receivedAtMs)).toEqual([arrival]);
  });

  it("receive times never go backwards along a document's chain, even when frames arrive out of clock order", async () => {
    await setup();
    const alice = await ids.enroll("alice", { "doc-1": "write" });
    const bob = await ids.enroll("bob", { "doc-1": "write" });
    const r = await start();
    const a = await connectAs(r.url, alice, clock, { docId: "doc-1" });
    const b = await connectAs(r.url, bob, clock, { docId: "doc-1" });
    clients.push(a, b);
    clock.advance(5000);
    await a.insert(0, "a");
    clock.t -= 3000; // the gateway's clock steps back
    await b.insert(0, "b");
    const rows = await world.rawStore.readUpdates("doc-1", 0, 10);
    expect(rows[1]?.receivedAtMs).toBe(rows[0]?.receivedAtMs);
    const rep = await verifyLedger(await exportLines(), trust);
    expect(rep.warnings.filter((w) => w.includes("went backwards"))).toEqual([]);
  });

  it("an export taken while edits keep arriving is a consistent snapshot", async () => {
    await setup();
    const { alice } = await edit();
    await writer().flush();
    const c = clients[0] as GatewayClient;
    const lines: string[] = [];
    let first = true;
    await exportLedger({ docs: world.rawStore as never, identity: world.identity, tenant: "acme", now: clock.now }, async (l) => {
      lines.push(l);
      if (first) {
        first = false;
        clock.advance(1000);
        await c.insert(0, "arrives mid-export "); // after the heads were captured
      }
    });
    const rep = await verifyLedger(lines.map((l) => JSON.parse(l) as unknown), trust, { locked: await lockedCopies(1) });
    expect(rep.violations).toEqual([]);
    expect(rep.counts.entries).toBe(4); // the late edit is not in this file
    expect(await world.rawStore.headSeq("doc-1")).toBe(4); // but it is in the ledger
    void alice;
  });

  it("an edit rejected by the gateway never reaches the ledger", async () => {
    await setup();
    const reader = await ids.enroll("reader", { "doc-1": "read" });
    const r = await start();
    const c = await connectAs(r.url, reader, clock, { docId: "doc-1" });
    clients.push(c);
    await c.insert(0, "nope").catch(() => {});
    await new Promise((res) => setTimeout(res, 50));
    expect(await world.rawStore.headSeq("doc-1")).toBe(0);
    await writer().flush();
    expect((await verifyLedger(await exportLines(), trust)).counts.entries).toBe(0);
  });

  describe("checkpoint writer", () => {
    it("writes nothing when nothing is pending, and respects the interval and entry triggers", async () => {
      await setup();
      const w = writer({ intervalMs: 10_000, maxEntries: 3 });
      await w.tick();
      expect(w.stats.written).toBe(0);
      await edit(); // 4 entries >= maxEntries
      await w.tick();
      expect(w.stats.written).toBe(1);

      const c = clients[0] as GatewayClient;
      clock.advance(1000);
      await c.insert(0, "x");
      await w.tick(); // 1 pending, interval not elapsed
      expect(w.stats.written).toBe(1);
      clock.advance(10_000);
      await w.tick();
      expect(w.stats.written).toBe(2);
    });

    it("splits a large set of changed documents across checkpoints and they chain", async () => {
      await setup();
      const alice = await ids.enroll("alice", { d1: "write", d2: "write", d3: "write", d4: "write", d5: "write" });
      const r = await start();
      for (const d of ["d1", "d2", "d3", "d4", "d5"]) {
        const c = await connectAs(r.url, alice, clock, { docId: d });
        clients.push(c);
        await c.insert(0, d);
      }
      const w = writer({ maxDocs: 2 });
      expect(await w.flush()).toBe(3);
      const rep = await verifyLedger(await exportLines(), trust, { locked: await lockedCopies(3) });
      expect(rep.violations).toEqual([]);
      expect(rep.counts.checkpoints).toBe(3);
    });

    it("an object-store outage leaves the checkpoint reserved, and the next tick uploads the same bytes", async () => {
      await setup();
      await edit();
      const objects = new FaultyObjectStore(checkpointObjects);
      const w = writer({ objects });
      objects.down = true;
      await w.flush();
      expect(w.stats.uploadFailures).toBe(1);
      expect(checkpointObjects.objects.size).toBe(0);
      const reserved = await (world.rawStore as unknown as LedgerStore).lastCheckpoint();
      expect(reserved?.uploadedAtMs).toBeUndefined();

      objects.down = false;
      await w.tick();
      const stored = await checkpointObjects.get(checkpointObjectKey("acme", 1));
      expect(stored && Buffer.from(stored).equals(Buffer.from(reserved?.bytes ?? new Uint8Array()))).toBe(true);
      expect(w.stats.written).toBe(1); // not re-reserved
      expect((await (world.rawStore as unknown as LedgerStore).lastCheckpoint())?.uploadedAtMs).toBeDefined();
    });

    it("a hung object store cannot wedge the writer", async () => {
      await setup();
      await edit();
      const objects = new FaultyObjectStore(checkpointObjects);
      objects.hang = true;
      const w = writer({ objects, objectTimeoutMs: 50 });
      await w.flush();
      expect(w.stats.uploadFailures).toBe(1);
    });

    it("two writers racing produce one object per n and a verifiable chain", async () => {
      await setup();
      await edit();
      const a = writer();
      const b = writer();
      await Promise.all([a.flush(), b.flush()]);
      expect(a.stats.written + b.stats.written).toBe(1);
      expect(checkpointObjects.objects.size).toBe(1);
      const rep = await verifyLedger(await exportLines(), trust, { locked: await lockedCopies(1) });
      expect(rep.ok).toBe(true);
    });

    it("a failing signer reserves nothing and is retried", async () => {
      await setup();
      await edit();
      let fail = true;
      const w = writer({ signer: { keyId: signer.keyId, publicKey: signer.publicKey, sign: (m) => (fail ? Promise.reject(new Error("kms down")) : signer.sign(m)) } });
      await w.flush();
      expect(w.stats.signFailures).toBe(1);
      expect(await (world.rawStore as unknown as LedgerStore).lastCheckpoint()).toBeUndefined();
      fail = false;
      expect(await w.flush()).toBe(1);
    });

    it("a signer that returns a signature that does not verify burns no checkpoint number", async () => {
      await setup();
      await edit();
      const other = ledgerSignerFromKeyPair(generateKeyPair(new Uint8Array(32).fill(77)));
      // Right key id, wrong key behind it: the signature would never verify against the published ledger key.
      const w = writer({ signer: { keyId: signer.keyId, publicKey: signer.publicKey, sign: other.sign } });
      expect(await w.flush()).toBe(0);
      expect(w.stats.signFailures).toBe(1);
      expect(await (world.rawStore as unknown as LedgerStore).lastCheckpoint()).toBeUndefined();
      expect(await writer().flush()).toBe(1); // n = 1 is still free
    });

    it("a signer that hangs is cut off and counted", async () => {
      await setup();
      await edit();
      const w = writer({ signer: { keyId: signer.keyId, publicKey: signer.publicKey, sign: () => new Promise<Uint8Array>(() => {}) }, signTimeoutMs: 30 });
      await w.flush();
      expect(w.stats.signFailures).toBe(1);
      expect(await (world.rawStore as unknown as LedgerStore).lastCheckpoint()).toBeUndefined();
    });

    it("never overwrites a different object under a reserved number, and stops writing until a human looks", async () => {
      await setup();
      await edit();
      await checkpointObjects.put(checkpointObjectKey("acme", 1), new Uint8Array([1, 2, 3]));
      const w = writer();
      await w.flush();
      expect(w.stats.uploadConflicts).toBe(1);
      expect([...((await checkpointObjects.get(checkpointObjectKey("acme", 1))) ?? [])]).toEqual([1, 2, 3]);
      expect((await (world.rawStore as unknown as LedgerStore).lastCheckpoint())?.uploadedAtMs).toBeUndefined();
      // More edits do not make the writer reserve n = 2 on top of an unresolved n = 1.
      const c = clients[0] as GatewayClient;
      clock.advance(1000);
      await c.insert(0, "later ");
      await w.flush();
      expect((await (world.rawStore as unknown as LedgerStore).lastCheckpoint())?.n).toBe(1);
      expect(w.stats.written).toBe(1);
    });

    it("an identical object already in the bucket counts as uploaded (a crash between put and mark)", async () => {
      await setup();
      await edit();
      const ledgerStore = world.rawStore as unknown as LedgerStore;
      const heads = await ledgerStore.pendingHeads(100);
      const bytes = await signCheckpoint({ n: 1, createdAtMs: clock.now(), prevCheckpointHash: ZERO_HASH, tenant: "acme", heads }, signer);
      expect(await ledgerStore.reserveCheckpoint({ n: 1, createdAtMs: clock.now(), prevHash: ZERO_HASH, hash: checkpointHash(bytes), bytes, heads })).toBe(true);
      await checkpointObjects.put(checkpointObjectKey("acme", 1), bytes); // the process died right here
      const w = writer();
      expect(await w.flush()).toBe(0);
      expect(w.stats.uploadConflicts).toBe(0);
      expect((await ledgerStore.lastCheckpoint())?.uploadedAtMs).toBeDefined();
    });

    it("a failed heal blocks new reservations", async () => {
      await setup();
      await edit();
      const objects = new FaultyObjectStore(checkpointObjects);
      const w = writer({ objects });
      objects.down = true;
      await w.flush();
      const c = clients[0] as GatewayClient;
      clock.advance(1000);
      await c.insert(0, "later ");
      await w.flush(); // heal of n = 1 fails again: do not reserve n = 2
      expect((await (world.rawStore as unknown as LedgerStore).lastCheckpoint())?.n).toBe(1);
      objects.down = false;
      expect(await w.flush()).toBe(1);
      expect((await (world.rawStore as unknown as LedgerStore).lastCheckpoint())?.n).toBe(2);
    });

    it("a store outage is counted, never thrown, and recovers", async () => {
      await setup();
      await edit();
      world.store.down = true;
      const w = writer({ store: world.store as unknown as LedgerStore });
      await w.tick();
      await w.flush();
      expect(w.stats.storeFailures).toBeGreaterThan(0);
      world.store.down = false;
      expect(await w.flush()).toBe(1);
    });

    it("checkpoint times never go backwards even if the clock does", async () => {
      await setup();
      await edit();
      const w = writer();
      await w.flush();
      const c = clients[0] as GatewayClient;
      await c.insert(0, "y");
      clock.t -= 10 * HOUR;
      await w.flush();
      const rep = await verifyLedger(await exportLines(), trust);
      expect(rep.violations.filter((v) => v.code === "checkpoint_time")).toEqual([]);
    });

    it("start() runs on a timer and stop() flushes what is pending", async () => {
      await setup();
      await edit();
      const w = writer({ pollMs: 10, intervalMs: 1, now: Date.now });
      w.start();
      await until(() => w.stats.written >= 1, 3000, "timer checkpoint");
      const c = clients[0] as GatewayClient;
      clock.advance(5);
      await c.insert(0, "z");
      await w.stop({ flush: true });
      expect(await (world.rawStore as unknown as LedgerStore).pendingEntries()).toBe(0);
    });

    it("rejects nonsense limits", async () => {
      await setup();
      expect(() => writer({ maxDocs: 0 })).toThrow(RangeError);
      expect(() => writer({ maxDocs: 100_001 })).toThrow(RangeError);
      expect(() => writer({ intervalMs: 1.5 })).toThrow(RangeError);
      expect(() => writer({ signTimeoutMs: Number.NaN })).toThrow(RangeError);
      expect(() => writer({ tenant: "" })).toThrow(RangeError);
      expect(() => writer({ tenant: "x".repeat(65) })).toThrow(RangeError);
      expect(() => writer({ tenant: "bad\ud800" })).toThrow(RangeError);
    });
  });

  if (kind === "postgres") {
    describe("a database administrator rewrites history", () => {
      const pool = () => (world.rawStore as PgDocumentStore).pool;
      const unlock = () => pool().query("ALTER TABLE document_updates DISABLE TRIGGER document_updates_append_only");

      it("editing a stored receive time is detected", async () => {
        await setup();
        await edit();
        await writer().flush();
        await unlock();
        await pool().query("UPDATE document_updates SET received_at_ms = received_at_ms + 1 WHERE document_id = 'doc-1' AND seq = 2");
        const rep = await verifyLedger(await exportLines(), trust);
        expect(rep.violations.map((v) => v.code)).toContain("entry_hash_mismatch");
      });

      it("deleting a middle entry or the last entry is detected", async () => {
        await setup();
        await edit();
        await writer().flush();
        await unlock();
        await pool().query("DELETE FROM document_updates WHERE document_id = 'doc-1' AND seq = 2");
        expect((await verifyLedger(await exportLines(), trust)).violations.map((v) => v.code)).toContain("chain_gap");

        await pool().query("DELETE FROM document_updates WHERE document_id = 'doc-1' AND seq = 3");
        expect((await verifyLedger(await exportLines(), trust)).violations.map((v) => v.code)).toContain("truncated");
      });

      it("replacing a payload and fixing every hash is detected by the signed checkpoint", async () => {
        await setup();
        await edit();
        await writer().flush();
        await unlock();
        // Rewrite entry 2 of doc-1 and re-chain everything after it, like a careful attacker with full database access.
        const rows = (await pool().query<{ seq: string; frame: Buffer; cert_serial: Buffer; received_at_ms: string; payload_hash: Buffer }>(
          "SELECT seq, frame, cert_serial, received_at_ms, payload_hash FROM document_updates WHERE document_id = 'doc-1' ORDER BY seq",
        )).rows;
        let prev: Uint8Array = Uint8Array.from(rows[0] ? (await world.rawStore.readUpdates("doc-1", 0, 1))[0]!.entryHash : ZERO_HASH);
        for (const row of rows.slice(1)) {
          const frame = new Uint8Array(row.frame);
          const fakePayload = hashBytes(new TextEncoder().encode(`forged-${row.seq}`));
          const h = entryHash({
            documentId: "doc-1",
            seq: Number(row.seq),
            prevHash: prev,
            receivedAtMs: Number(row.received_at_ms),
            keyEpoch: 0,
            certSerial: new Uint8Array(row.cert_serial),
            frameHash: hashBytes(frame),
            payloadHash: fakePayload,
          });
          await pool().query("UPDATE document_updates SET prev_hash = $3, payload_hash = $4, entry_hash = $5 WHERE document_id = 'doc-1' AND seq = $1 AND $2::int IS NOT NULL", [
            row.seq, 1, Buffer.from(prev), Buffer.from(fakePayload), Buffer.from(h),
          ]);
          prev = h;
        }
        await pool().query("UPDATE documents SET head_hash = $1 WHERE id = 'doc-1'", [Buffer.from(prev)]);
        const rep = await verifyLedger(await exportLines(), trust);
        const codes = rep.violations.map((v) => v.code);
        expect(codes).toContain("checkpoint_head_mismatch");
      });

      it("replacing the whole database with a consistent fake is caught by the locked copies", async () => {
        await setup();
        await edit();
        await writer().flush();
        const locked = await lockedCopies(1);
        // A fake ledger the attacker built in a second world, with its own (unlocked) checkpoint.
        const real = world;
        const fakeObjects = new MemoryObjectStore();
        world = await makeWorld(kind);
        ids = new TestIdentity(world.identity, clock);
        await edit();
        await new CheckpointWriter({ store: world.rawStore as unknown as LedgerStore, objects: fakeObjects, tenant: "acme", signer, now: clock.now }).flush();
        const rep = await verifyLedger(await exportLines(), trust, { locked });
        // Different keys sign different frames, so the fake checkpoint differs from the locked one.
        expect(rep.violations.map((v) => v.code)).toContain("locked_mismatch");
        await real.cleanup();
      });
    });
  }
});
