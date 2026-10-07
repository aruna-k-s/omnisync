import { IDBFactory } from "fake-indexeddb";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { IndexedDbOutbox, MemoryOutbox, newSessionId, type Outbox, type OutboxFrame } from "../src/outbox.js";

const frame = (sessionId: number, seq: number, fill = seq): OutboxFrame => ({ sessionId, seq, bytes: new Uint8Array(4).fill(fill), claimedAtMs: 1000 + seq });

const impls: [string, () => { make: () => Outbox; reopen: (o: Outbox) => Outbox }][] = [
  [
    "memory",
    () => {
      let shared: MemoryOutbox | undefined;
      return {
        make: () => (shared = new MemoryOutbox()),
        reopen: () => shared as MemoryOutbox, // memory has no disk: the same object stands in
      };
    },
  ],
  [
    "indexeddb",
    () => {
      const idb = new IDBFactory();
      let n = 0;
      let name = "";
      return {
        make: () => new IndexedDbOutbox({ name: (name = `ob${n++}`), indexedDB: idb }),
        reopen: (o) => {
          void o.close();
          return new IndexedDbOutbox({ name, indexedDB: idb });
        },
      };
    },
  ],
];

describe.each(impls)("outbox contract: %s", (_n, setup) => {
  it("returns appended frames in insertion order, untouched", async () => {
    const { make } = setup();
    const ob = make();
    await ob.append([frame(5, 1), frame(5, 2)]);
    await ob.append([frame(5, 3), frame(9, 1)]);
    expect((await ob.pending()).map((f) => [f.sessionId, f.seq])).toEqual([
      [5, 1],
      [5, 2],
      [5, 3],
      [9, 1],
    ]);
    const f = (await ob.pending())[0] as OutboxFrame;
    expect(Array.from(f.bytes)).toEqual([1, 1, 1, 1]);
    expect(f.claimedAtMs).toBe(1001);
  });

  it("acknowledging removes only that frame and keeps numbering", async () => {
    const { make } = setup();
    const ob = make();
    await ob.append([frame(5, 1), frame(5, 2)]);
    await ob.ack(5, 1);
    await ob.ack(5, 99); // unknown: no-op
    expect((await ob.pending()).map((f) => f.seq)).toEqual([2]);
    await ob.ack(5, 2);
    expect(await ob.pending()).toEqual([]);
    expect(await ob.highestSeq(5)).toBe(2);
    expect(await ob.highestSeq(6)).toBe(0);
  });

  it("is atomic: a refused frame leaves nothing behind", async () => {
    const { make } = setup();
    const ob = make();
    await ob.append([frame(5, 1)]);
    await expect(ob.append([frame(5, 2), frame(5, 1, 77)])).rejects.toThrow(/different bytes/);
    expect((await ob.pending()).map((f) => f.seq)).toEqual([1]);
    expect(await ob.highestSeq(5)).toBe(1);
  });

  it("appending the same frame again is a no-op, and an acknowledged number cannot come back", async () => {
    const { make } = setup();
    const ob = make();
    await ob.append([frame(5, 1)]);
    await ob.append([frame(5, 1)]);
    expect(await ob.pending()).toHaveLength(1);
    await ob.ack(5, 1);
    await expect(ob.append([frame(5, 1)])).rejects.toThrow(/before/);
  });

  it("rejects malformed numbering and duplicates inside one append", async () => {
    const { make } = setup();
    const ob = make();
    await expect(ob.append([frame(5, 0)])).rejects.toThrow();
    await expect(ob.append([frame(-1, 1)])).rejects.toThrow();
    await expect(ob.append([frame(5, 1), frame(5, 1)])).rejects.toThrow();
    expect(await ob.pending()).toEqual([]);
  });

  it("survives a reload: pending frames and the highest seq come back", async () => {
    const { make, reopen } = setup();
    const ob = make();
    await ob.append([frame(5, 1), frame(5, 2), frame(5, 3)]);
    await ob.ack(5, 1);
    const again = reopen(ob);
    expect((await again.pending()).map((f) => f.seq)).toEqual([2, 3]);
    expect(await again.highestSeq(5)).toBe(3);
  });

  it("keeps the last snapshot, and a reload sees it", async () => {
    const { make, reopen } = setup();
    const ob = make();
    expect(await ob.loadSnapshot()).toBeUndefined();
    await ob.saveSnapshot(Uint8Array.of(1, 2, 3));
    await ob.saveSnapshot(Uint8Array.of(4, 5));
    const bytes = Uint8Array.of(9, 9);
    await ob.saveSnapshot(bytes);
    bytes.fill(0);
    expect(Array.from((await reopen(ob).loadSnapshot())!)).toEqual([9, 9]);
  });

  it("does not alias the caller's bytes", async () => {
    const { make } = setup();
    const ob = make();
    const f = frame(5, 1);
    await ob.append([f]);
    f.bytes.fill(255);
    expect(Array.from((await ob.pending())[0]!.bytes)).toEqual([1, 1, 1, 1]);
  });

  it("property: pending is exactly appended minus acknowledged, in order", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(fc.constantFrom(1, 2, 3), fc.boolean()), { maxLength: 30 }), async (ops) => {
        const { make } = setup();
        const ob = make();
        const next = new Map<number, number>();
        const model: [number, number][] = [];
        for (const [session, ackNow] of ops) {
          const seq = (next.get(session) ?? 0) + 1;
          next.set(session, seq);
          await ob.append([frame(session, seq)]);
          model.push([session, seq]);
          if (ackNow) {
            const i = Math.floor(model.length / 2);
            const [s, q] = model.splice(i, 1)[0]!;
            await ob.ack(s, q);
          }
        }
        expect((await ob.pending()).map((f) => [f.sessionId, f.seq])).toEqual(model);
        for (const [s, n] of next) expect(await ob.highestSeq(s)).toBe(n);
      }),
      { numRuns: 40 },
    );
  });
});

describe("session numbering", () => {
  it("never repeats a session id that was used, across reloads", async () => {
    const ob = new MemoryOutbox();
    await ob.append([frame(42, 1)]);
    await ob.ack(42, 1);
    const draws = [42 / (2 ** 31 - 1) - 1e-12, 7 / (2 ** 31 - 1)];
    const id = await newSessionId(ob, () => draws.shift() ?? 0.5);
    expect(id).not.toBe(42);
    expect(id).toBeGreaterThan(0);
  });

  it("gives up rather than loop forever when every draw is taken", async () => {
    const ob = new MemoryOutbox();
    await ob.append([frame(1, 1)]);
    await expect(newSessionId(ob, () => 0)).rejects.toThrow(/unused session id/);
  });
});
