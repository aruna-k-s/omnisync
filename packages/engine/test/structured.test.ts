import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { engines, type EngineDoc, type Json, type Path } from "../src/index.js";

type Tree = { [key: string]: Json };

/** Every container (map or array) in the tree, with its path, in a fixed order. */
function containers(data: Tree): { path: Path; kind: "map" | "array"; size: number }[] {
  const out: { path: Path; kind: "map" | "array"; size: number }[] = [];
  const walk = (value: Json, path: Path): void => {
    if (Array.isArray(value)) {
      out.push({ path, kind: "array", size: value.length });
      value.forEach((v, i) => walk(v, [...path, i]));
    } else if (value !== null && typeof value === "object") {
      const keys = Object.keys(value).sort();
      out.push({ path, kind: "map", size: keys.length });
      for (const k of keys) walk((value as Tree)[k] as Json, [...path, k]);
    }
  };
  walk(data, []);
  return out;
}

const jsonArb: fc.Arbitrary<Json> = fc.letrec<{ v: Json }>((tie) => ({
  v: fc.oneof(
    { depthSize: "small", maxDepth: 2 },
    fc.constant(null),
    fc.boolean(),
    fc.integer({ min: -1000, max: 1000 }),
    fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 }).filter((n) => !Object.is(n, -0)),
    fc.string({ maxLength: 6 }),
    fc.array(tie("v"), { maxLength: 3 }),
    fc.dictionary(fc.constantFrom("a", "b", "c", "constructor", "toString", ""), tie("v"), { maxKeys: 3 }),
  ),
})).v;

type DataOp =
  | { replica: number; kind: "set"; pick: number; key: string; value: Json }
  | { replica: number; kind: "del"; pick: number; keyPick: number }
  | { replica: number; kind: "ins"; pick: number; at: number; values: Json[] }
  | { replica: number; kind: "rm"; pick: number; at: number; count: number }
  | { replica: number; kind: "text"; at: number; text: string };

const opArb = (replicas: number) =>
  fc.oneof(
    fc.record({ replica: fc.nat(replicas - 1), kind: fc.constant("set" as const), pick: fc.nat(1000), key: fc.constantFrom("a", "b", "c", "d", "constructor"), value: jsonArb }),
    fc.record({ replica: fc.nat(replicas - 1), kind: fc.constant("del" as const), pick: fc.nat(1000), keyPick: fc.nat(1000) }),
    fc.record({ replica: fc.nat(replicas - 1), kind: fc.constant("ins" as const), pick: fc.nat(1000), at: fc.nat(1000), values: fc.array(jsonArb, { minLength: 1, maxLength: 3 }) }),
    fc.record({ replica: fc.nat(replicas - 1), kind: fc.constant("rm" as const), pick: fc.nat(1000), at: fc.nat(1000), count: fc.integer({ min: 1, max: 3 }) }),
    fc.record({ replica: fc.nat(replicas - 1), kind: fc.constant("text" as const), at: fc.nat(1000), text: fc.string({ minLength: 1, maxLength: 4 }) }),
  );

/** Applies one random edit to a replica, resolving every choice against what that replica currently holds. */
function applyOp(doc: EngineDoc, op: DataOp): Uint8Array | undefined {
  if (op.kind === "text") return doc.insertText(op.at % (doc.getText().length + 1), op.text);
  const cs = containers(doc.getData());
  if (op.kind === "set") {
    const maps = cs.filter((c) => c.kind === "map");
    const m = maps[op.pick % maps.length] as (typeof maps)[number];
    return doc.mapSet(m.path, op.key, op.value);
  }
  if (op.kind === "del") {
    const maps = cs.filter((c) => c.kind === "map" && c.size > 0);
    if (maps.length === 0) return undefined;
    const m = maps[op.pick % maps.length] as (typeof maps)[number];
    const keys = Object.keys(walkTo(doc.getData(), m.path) as Tree).sort();
    return doc.mapDelete(m.path, keys[op.keyPick % keys.length] as string);
  }
  const arrays = cs.filter((c) => c.kind === "array");
  if (op.kind === "ins") {
    if (arrays.length === 0) {
      return doc.mapSet([], "list", op.values);
    }
    const a = arrays[op.pick % arrays.length] as (typeof arrays)[number];
    return doc.arrayInsert(a.path, op.at % (a.size + 1), op.values);
  }
  const nonEmpty = arrays.filter((c) => c.size > 0);
  if (nonEmpty.length === 0) return undefined;
  const a = nonEmpty[op.pick % nonEmpty.length] as (typeof nonEmpty)[number];
  const at = op.at % a.size;
  return doc.arrayDelete(a.path, at, Math.min(op.count, a.size - at));
}

function walkTo(data: Tree, path: Path): Json {
  let cur: Json = data;
  for (const step of path) cur = (cur as never)[step];
  return cur;
}

/** Key order is not part of the contract, so compare a canonical form. */
const canon = (v: Json): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x !== null && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
  );

const hash = (a: number, b: number) => Math.imul(a ^ 0x9e3779b9, 2654435761) ^ Math.imul(b + 1, 40503);

for (const engine of Object.values(engines)) {
  describe(`${engine.name}: structured data`, () => {
    it("starts empty and builds nested maps and arrays", () => {
      const d = engine.create(1);
      expect(d.getData()).toEqual({});
      d.mapSet([], "title", "Q3 plan");
      d.mapSet([], "rows", []);
      d.arrayInsert(["rows"], 0, [{ name: "a", qty: 1 }, { name: "b", qty: 2.5 }]);
      d.mapSet(["rows", 1], "tags", ["x", null, true]);
      d.arrayInsert(["rows", 1, "tags"], 3, [{ deep: { deeper: [1, 2, 3] } }]);
      expect(d.getData()).toEqual({
        title: "Q3 plan",
        rows: [{ name: "a", qty: 1 }, { name: "b", qty: 2.5, tags: ["x", null, true, { deep: { deeper: [1, 2, 3] } }] }],
      });
      d.destroy();
    });

    it("replaces, deletes and removes", () => {
      const d = engine.create(1);
      d.mapSet([], "k", 1);
      d.mapSet([], "k", "two");
      d.mapSet([], "gone", { a: 1 });
      d.mapDelete([], "gone");
      d.mapSet([], "list", [1, 2, 3, 4, 5]);
      d.arrayDelete(["list"], 1, 3);
      expect(d.getData()).toEqual({ k: "two", list: [1, 5] });
      d.destroy();
    });

    it("keeps text and data side by side", () => {
      const d = engine.create(1);
      d.insertText(0, "hello");
      d.mapSet([], "n", 7);
      expect(d.getText()).toBe("hello");
      expect(d.getData()).toEqual({ n: 7 });
      d.destroy();
    });

    it("returns one update per call and that update alone reproduces the edit elsewhere", () => {
      const a = engine.create(1);
      const b = engine.create(2);
      const u1 = a.mapSet([], "rows", []);
      const u2 = a.arrayInsert(["rows"], 0, [{ x: 1 }]);
      b.applyUpdate(u1);
      b.applyUpdate(u2);
      expect(b.getData()).toEqual({ rows: [{ x: 1 }] });
      a.destroy();
      b.destroy();
    });

    it("deleting a missing key or zero items is a harmless update", () => {
      const a = engine.create(1);
      const b = engine.create(2);
      a.mapSet([], "list", [1]);
      b.applyUpdate(a.snapshot());
      const u1 = a.mapDelete([], "nope");
      const u2 = a.arrayDelete(["list"], 0, 0);
      expect(u1).toBeInstanceOf(Uint8Array);
      expect(u2).toBeInstanceOf(Uint8Array);
      b.applyUpdate(u1);
      b.applyUpdate(u2);
      expect(b.getData()).toEqual({ list: [1] });
      a.destroy();
      b.destroy();
    });

    it("refuses bad paths, wrong container kinds and bad indices, and changes nothing", () => {
      const d = engine.create(1);
      d.mapSet([], "m", { k: 1 });
      d.mapSet([], "l", [1, 2]);
      const before = JSON.stringify(d.getData());
      expect(() => d.mapSet(["nope"], "k", 1)).toThrow(RangeError);
      expect(() => d.mapSet(["l"], "k", 1)).toThrow(RangeError); // an array is not a map
      expect(() => d.arrayInsert(["m"], 0, [1])).toThrow(RangeError); // a map is not an array
      expect(() => d.mapSet(["m", "k"], "x", 1)).toThrow(RangeError); // a number is not a container
      expect(() => d.mapSet(["l", 5], "x", 1)).toThrow(RangeError);
      expect(() => d.mapSet(["l", -1], "x", 1)).toThrow(RangeError);
      expect(() => d.mapSet(["l", 1.5], "x", 1)).toThrow(RangeError);
      expect(() => d.arrayInsert(["l"], 3, [1])).toThrow(RangeError);
      expect(() => d.arrayInsert(["l"], -1, [1])).toThrow(RangeError);
      expect(() => d.arrayInsert(["l"], 1.5, [1])).toThrow(RangeError);
      expect(() => d.arrayDelete(["l"], 1, 2)).toThrow(RangeError);
      expect(() => d.arrayDelete(["l"], 0, -1)).toThrow(RangeError);
      expect(() => d.mapDelete(["l"], "k")).toThrow(RangeError);
      expect(JSON.stringify(d.getData())).toBe(before);
      d.destroy();
    });

    it("refuses values that are not plain JSON, and changes nothing", () => {
      const d = engine.create(1);
      const bad: unknown[] = [
        undefined,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        10n,
        () => 1,
        Symbol("s"),
        new Date(0),
        new Map(),
        new Uint8Array(2),
        // eslint-disable-next-line no-sparse-arrays
        [1, , 3],
        { nested: [undefined] },
        "lone\ud800surrogate",
        Object.create({ inherited: 1 }),
        new (class Sub extends Array {})(),
        { [Symbol("hidden")]: 1 },
        Object.defineProperty({}, "computed", { get: () => 1, enumerable: true }),
        { "bad\ud800key": 1 },
      ];
      for (const v of bad) expect(() => d.mapSet([], "k", v as Json), String(v)).toThrow(RangeError);
      expect(() => d.arrayInsert([], 0, [1])).toThrow(RangeError);
      d.mapSet([], "l", []);
      expect(() => d.arrayInsert(["l"], 0, [1, undefined as unknown as Json])).toThrow(RangeError);
      let deep: Json = 1;
      for (let i = 0; i < 33; i++) deep = [deep];
      expect(() => d.mapSet([], "deep", deep)).toThrow(RangeError);
      let ok: Json = 1;
      for (let i = 0; i < 31; i++) ok = [ok];
      expect(() => d.mapSet([], "ok", ok)).not.toThrow();
      expect(() => d.mapSet([], "big", Array.from({ length: 100_001 }, () => 0))).toThrow(RangeError);
      expect(() => d.mapSet([], "__proto__", 1)).toThrow(RangeError);
      expect(() => d.mapSet([], "lone\ud800", 1)).toThrow(RangeError);
      expect(() => d.mapDelete([], "lone\ud800")).toThrow(RangeError);
      expect(() => d.mapSet(["lone\ud800"], "k", 1)).toThrow(RangeError);
      expect(() => d.mapSet([], "k", JSON.parse('{"__proto__": 1}') as Json)).toThrow(RangeError);
      expect(() => d.mapDelete([], "__proto__")).toThrow(RangeError);
      expect(Object.keys(d.getData()).sort()).toEqual(["l", "ok"]);
      d.destroy();
    });

    it("is safe with keys that name object prototype members", () => {
      const d = engine.create(1);
      for (const k of ["constructor", "toString", "hasOwnProperty", "valueOf", ""]) d.mapSet([], k, k.length);
      const data = d.getData();
      expect(Object.keys(data).sort()).toEqual(["", "constructor", "hasOwnProperty", "toString", "valueOf"]);
      expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
      d.destroy();
    });

    it("concurrent writes to one key converge to one value; concurrent inserts into one list all survive", () => {
      const a = engine.create(1);
      const b = engine.create(2);
      const base = a.mapSet([], "list", ["x"]);
      b.applyUpdate(base);
      const ua = [a.mapSet([], "k", "from a"), a.arrayInsert(["list"], 1, ["a1"])];
      const ub = [b.mapSet([], "k", "from b"), b.arrayInsert(["list"], 1, ["b1"])];
      for (const u of ub) a.applyUpdate(u);
      for (const u of ua) b.applyUpdate(u);
      expect(a.getData()).toEqual(b.getData());
      const data = a.getData() as { k: string; list: string[] };
      expect(["from a", "from b"]).toContain(data.k);
      expect([...data.list].sort()).toEqual(["a1", "b1", "x"]);
      a.destroy();
      b.destroy();
    });

    it("different cells of one row merge instead of overwriting", () => {
      const a = engine.create(1);
      const b = engine.create(2);
      const setup = [a.mapSet([], "row", {}), a.mapSet(["row"], "left", 0), a.mapSet(["row"], "right", 0)];
      for (const u of setup) b.applyUpdate(u);
      const ua = a.mapSet(["row"], "left", 1);
      const ub = b.mapSet(["row"], "right", 2);
      a.applyUpdate(ub);
      b.applyUpdate(ua);
      expect(a.getData()).toEqual({ row: { left: 1, right: 2 } });
      expect(b.getData()).toEqual({ row: { left: 1, right: 2 } });
      a.destroy();
      b.destroy();
    });

    it("converges when every update reaches every replica in any order, with duplicates (text and data together)", () => {
      fc.assert(
        fc.property(fc.array(opArb(3), { minLength: 1, maxLength: 25 }), fc.integer(), (ops, seed) => {
          const docs = [1, 2, 3].map((a) => engine.create(a));
          const outbox: { from: number; update: Uint8Array }[] = [];
          for (const op of ops) {
            const update = applyOp(docs[op.replica] as EngineDoc, op);
            if (update) outbox.push({ from: op.replica, update });
          }
          const delivery = [...outbox, ...outbox].map((m, i) => ({ m, k: hash(seed, i) })).sort((x, y) => x.k - y.k);
          docs.forEach((doc, idx) => {
            for (const { m } of delivery) if (m.from !== idx) doc.applyUpdate(m.update);
          });
          expect(new Set(docs.map((d) => d.getText())).size).toBe(1);
          const datas = docs.map((d) => canon(d.getData()));
          expect(new Set(datas).size).toBe(1);
          docs.forEach((d) => d.destroy());
        }),
        { numRuns: engine.name === "automerge" ? 30 : 80 },
      );
    });

    it("matches a plain JavaScript model operation by operation (a single replica)", () => {
      fc.assert(
        fc.property(fc.array(opArb(1), { minLength: 1, maxLength: 30 }), (ops) => {
          const d = engine.create(1);
          const model: Tree = {};
          let text = "";
          for (const op of ops) {
            const cs = containers(model as Tree);
            if (op.kind === "text") {
              const at = op.at % (text.length + 1);
              d.insertText(at, op.text);
              text = text.slice(0, at) + op.text + text.slice(at);
            } else if (op.kind === "set") {
              const maps = cs.filter((c) => c.kind === "map");
              const m = maps[op.pick % maps.length] as (typeof maps)[number];
              d.mapSet(m.path, op.key, op.value);
              (walkTo(model, m.path) as Tree)[op.key] = JSON.parse(JSON.stringify(op.value)) as Json;
            } else if (op.kind === "del") {
              const maps = cs.filter((c) => c.kind === "map" && c.size > 0);
              if (maps.length === 0) continue;
              const m = maps[op.pick % maps.length] as (typeof maps)[number];
              const target = walkTo(model, m.path) as Tree;
              const keys = Object.keys(target).sort();
              const k = keys[op.keyPick % keys.length] as string;
              d.mapDelete(m.path, k);
              delete target[k];
            } else if (op.kind === "ins") {
              const arrays = cs.filter((c) => c.kind === "array");
              if (arrays.length === 0) {
                d.mapSet([], "list", op.values);
                model["list"] = JSON.parse(JSON.stringify(op.values)) as Json;
                continue;
              }
              const a = arrays[op.pick % arrays.length] as (typeof arrays)[number];
              const at = op.at % (a.size + 1);
              d.arrayInsert(a.path, at, op.values);
              (walkTo(model, a.path) as Json[]).splice(at, 0, ...(JSON.parse(JSON.stringify(op.values)) as Json[]));
            } else {
              const arrays = cs.filter((c) => c.kind === "array" && c.size > 0);
              if (arrays.length === 0) continue;
              const a = arrays[op.pick % arrays.length] as (typeof arrays)[number];
              const at = op.at % a.size;
              const n = Math.min(op.count, a.size - at);
              d.arrayDelete(a.path, at, n);
              (walkTo(model, a.path) as Json[]).splice(at, n);
            }
            expect(canon(d.getData())).toBe(canon(model));
            expect(d.getText()).toBe(text);
          }
          d.destroy();
        }),
        { numRuns: engine.name === "automerge" ? 40 : 100 },
      );
    });

    it("inserting in the middle and at the start shifts what was there", () => {
      const d = engine.create(1);
      d.mapSet([], "l", [1, 2, 3]);
      d.arrayInsert(["l"], 1, ["a", "b"]);
      d.arrayInsert(["l"], 0, [{ z: 1 }]);
      d.arrayInsert(["l"], 6, ["end"]);
      expect(d.getData()).toEqual({ l: [{ z: 1 }, 1, "a", "b", 2, 3, "end"] });
      d.destroy();
    });

    it("a state-vector diff brings a stale replica level, data included", () => {
      fc.assert(
        fc.property(fc.array(opArb(2), { minLength: 1, maxLength: 20 }), (ops) => {
          const a = engine.create(1);
          const b = engine.create(2);
          for (const op of ops) applyOp(op.replica === 0 ? a : b, op);
          b.applyUpdate(a.encodeDiff(b.encodeStateVector()));
          a.applyUpdate(b.encodeDiff(a.encodeStateVector()));
          expect(canon(a.getData())).toBe(canon(b.getData()));
          expect(a.getText()).toBe(b.getText());
          a.destroy();
          b.destroy();
        }),
        { numRuns: engine.name === "automerge" ? 25 : 60 },
      );
    });

    it("a snapshot restores text and data, and the restored replica converges with the original", () => {
      fc.assert(
        fc.property(fc.array(opArb(1), { minLength: 1, maxLength: 15 }), fc.array(opArb(1), { maxLength: 6 }), (before, after) => {
          const a = engine.create(1);
          for (const op of before) applyOp(a, op);
          const restored = engine.load(a.snapshot(), 2);
          expect(restored.getData()).toEqual(a.getData());
          expect(restored.getText()).toBe(a.getText());
          const updates: Uint8Array[] = [];
          for (const op of after) {
            const u = applyOp(restored, op);
            if (u) updates.push(u);
          }
          for (const u of updates) a.applyUpdate(u);
          expect(canon(a.getData())).toBe(canon(restored.getData()));
          a.destroy();
          restored.destroy();
        }),
        { numRuns: engine.name === "automerge" ? 25 : 60 },
      );
    });

    it("round-trips numbers as numbers, large and small, integer and fractional", () => {
      const d = engine.create(1);
      const values = [0, 1, -1, 3, 3.5, -0.25, 1e-7, 123456789012, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 1e21, 5e-324];
      d.mapSet([], "n", values);
      const back = (d.getData() as { n: number[] }).n;
      expect(back).toEqual(values);
      const other = engine.create(2);
      other.applyUpdate(d.snapshot());
      expect((other.getData() as { n: number[] }).n).toEqual(values);
      d.destroy();
      other.destroy();
    });
  });
}
