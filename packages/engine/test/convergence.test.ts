import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { engines, getEngine, type EngineDoc } from "../src/index.js";

/** A random local edit, resolved against the replica's current length when applied. */
type Op = { replica: number; kind: "ins"; at: number; text: string } | { replica: number; kind: "del"; at: number; len: number };

const opArb = (replicas: number) =>
  fc.oneof(
    fc.record({
      replica: fc.nat(replicas - 1),
      kind: fc.constant("ins" as const),
      at: fc.nat(1000),
      text: fc.string({ minLength: 1, maxLength: 5 }),
    }),
    fc.record({ replica: fc.nat(replicas - 1), kind: fc.constant("del" as const), at: fc.nat(1000), len: fc.integer({ min: 1, max: 4 }) }),
  );

function applyLocal(doc: EngineDoc, op: Op): Uint8Array | undefined {
  const len = doc.getText().length;
  if (op.kind === "ins") return doc.insertText(op.at % (len + 1), op.text);
  if (len === 0) return undefined;
  const at = op.at % len;
  return doc.deleteText(at, Math.min(op.len, len - at));
}

for (const engine of Object.values(engines)) {
  describe(`${engine.name} adapter`, () => {
    it("applies local edits", () => {
      const doc = engine.create(1);
      doc.insertText(0, "hello");
      doc.insertText(5, " world");
      doc.deleteText(0, 6);
      expect(doc.getText()).toBe("world");
      expect(() => doc.insertText(99, "x")).toThrow(RangeError);
      doc.destroy();
    });

    it("converges when every update reaches every replica in any order, with duplicates", () => {
      fc.assert(
        fc.property(fc.array(opArb(3), { minLength: 1, maxLength: 30 }), fc.integer(), (ops, shuffleSeed) => {
          const docs = [1, 2, 3].map((a) => engine.create(a));
          const outbox: { from: number; update: Uint8Array }[] = [];
          for (const op of ops) {
            const update = applyLocal(docs[op.replica] as EngineDoc, op);
            if (update) outbox.push({ from: op.replica, update });
          }
          // Deliver in a deterministic shuffled order, each update twice.
          const delivery = [...outbox, ...outbox].map((m, i) => ({ m, k: hash(shuffleSeed, i) })).sort((a, b) => a.k - b.k);
          docs.forEach((doc, idx) => {
            for (const { m } of delivery) if (m.from !== idx) doc.applyUpdate(m.update);
          });
          const texts = docs.map((d) => d.getText());
          expect(new Set(texts).size).toBe(1);
          docs.forEach((d) => d.destroy());
        }),
        { numRuns: engine.name === "automerge" ? 40 : 100 },
      );
    });

    it("state-vector sync brings a stale replica up to date", () => {
      const a = engine.create(1);
      const b = engine.create(2);
      a.insertText(0, "abc");
      b.applyUpdate(a.encodeDiff(b.encodeStateVector()));
      a.insertText(3, "def");
      b.insertText(0, ">");
      // Both directions, as the gateway does on reconnect: SYNC_1 then SYNC_2.
      b.applyUpdate(a.encodeDiff(b.encodeStateVector()));
      a.applyUpdate(b.encodeDiff(a.encodeStateVector()));
      expect(a.getText()).toBe(b.getText());
      expect(a.getText()).toContain("abcdef");
      a.destroy();
      b.destroy();
    });

    it("snapshot round-trips and keeps accepting edits", () => {
      const a = engine.create(1);
      a.insertText(0, "persist me");
      const restored = engine.load(a.snapshot(), 2);
      expect(restored.getText()).toBe("persist me");
      a.applyUpdate(restored.insertText(0, "> "));
      expect(a.getText()).toBe("> persist me");
      a.destroy();
      restored.destroy();
    });
  });
}

it("getEngine rejects unknown names", () => {
  expect(getEngine("yjs").name).toBe("yjs");
  expect(() => getEngine("nope")).toThrow(/unknown engine/);
});

function hash(seed: number, i: number): number {
  let h = (seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  return (h ^ (h >>> 13)) >>> 0;
}
