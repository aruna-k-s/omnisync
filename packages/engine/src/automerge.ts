import * as A from "@automerge/automerge";
import { assertActor, assertIndex, assertKey, assertPath, clampRange, cloneJson, type EngineDoc, type Json, type Path, type SyncEngine } from "./types.js";

interface Shape {
  text: string;
  data: { [key: string]: Json };
}

/**
 * Automerge keeps JS integers as 64-bit ints and reads some of them back as BigInt (2^53-1) or clamps them (1e21).
 * Fractions are floats already. Large integers are stored as explicit floats, which read back as plain numbers.
 * An explicit float only converts when assigned directly to a slot, so containers are built one slot at a time.
 */
const needsFloat = (n: number): boolean => Number.isInteger(n) && Math.abs(n) >= 2 ** 52;

/** Writes `v` into a slot of an Automerge change. `set` places a value, `get` reads the slot back as a live container. */
function put(set: (x: unknown) => void, get: () => unknown, v: Json): void {
  if (typeof v === "number") return set(needsFloat(v) ? new A.Float64(v) : v);
  if (Array.isArray(v)) {
    set([]);
    const list = get() as unknown[];
    v.forEach((x, i) => putInList(list, i, x));
    return;
  }
  if (v !== null && typeof v === "object") {
    set({});
    const map = get() as Record<string, unknown>;
    for (const [k, x] of Object.entries(v))
      put(
        (y) => void (map[k] = y),
        () => map[k],
        x,
      );
    return;
  }
  set(v);
}

/** Inserts `v` at `i`. A float only converts when assigned to an existing slot, so insert a placeholder first. */
function putInList(list: unknown[], i: number, v: Json): void {
  list.splice(i, 0, null);
  put(
    (y) => void (list[i] = y),
    () => list[i],
    v,
  );
}

const isList = (x: unknown): x is unknown[] => Array.isArray(x);
const isMap = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x) && !(x instanceof A.Float64);

/** Walks `path` from `root`. Throws RangeError unless it ends on a map or an array. */
function resolve(root: unknown, path: Path): unknown {
  let cur: unknown = root;
  for (const step of path) {
    if (isMap(cur) && typeof step === "string") cur = cur[step];
    else if (isList(cur) && typeof step === "number") cur = cur[step];
    else throw new RangeError("path does not lead to a container");
  }
  if (!isMap(cur) && !isList(cur)) throw new RangeError("path does not lead to a map or an array");
  return cur;
}

const actorHex = (actor: number) => actor.toString(16).padStart(8, "0").padEnd(32, "0");

/** State vector = sorted heads, newline-joined, UTF-8. */
const encodeHeads = (heads: A.Heads) => new TextEncoder().encode([...heads].sort().join("\n"));
const decodeHeads = (bytes: Uint8Array): A.Heads => {
  const s = new TextDecoder().decode(bytes);
  return s.length === 0 ? [] : s.split("\n");
};

// All replicas start from the same zero-actor base change so their "text"
// fields share one object id. Without this, two replicas would each create
// their own "text" and one would win the map key, losing the other's edits.
const BASE = A.save(
  A.change(A.init<Shape>({ actor: "00".repeat(16) }), { time: 0 }, (d) => {
    d.text = "";
    d.data = {};
  }),
);

class AutomergeDoc implements EngineDoc {
  readonly engine = "automerge" as const;
  #doc: A.Doc<Shape>;

  constructor(actor: number, snapshot: Uint8Array = BASE) {
    assertActor(actor);
    this.#doc = A.load<Shape>(snapshot, { actor: actorHex(actor) });
  }

  #edit(fn: (d: Shape) => void): Uint8Array {
    const heads = A.getHeads(this.#doc);
    this.#doc = A.change(this.#doc, fn);
    return A.saveSince(this.#doc, heads);
  }

  insertText(index: number, text: string): Uint8Array {
    clampRange(this.#doc.text.length, index);
    return this.#edit((d) => A.splice(d, ["text"], index, 0, text));
  }

  deleteText(index: number, length: number): Uint8Array {
    clampRange(this.#doc.text.length, index, length);
    return this.#edit((d) => A.splice(d, ["text"], index, length));
  }

  getText(): string {
    return this.#doc.text;
  }

  #mapAt(root: unknown, path: Path): Record<string, unknown> {
    const c = resolve(root, path);
    if (!isMap(c)) throw new RangeError("path leads to an array, not a map");
    return c;
  }

  #arrayAt(root: unknown, path: Path): unknown[] {
    const c = resolve(root, path);
    if (!isList(c)) throw new RangeError("path leads to a map, not an array");
    return c;
  }

  mapSet(path: Path, key: string, value: Json): Uint8Array {
    assertPath(path);
    assertKey(key);
    const v = cloneJson(value);
    return this.#edit((d) => {
      const m = this.#mapAt(d.data, path);
      put(
        (x) => void (m[key] = x),
        () => m[key],
        v,
      );
    });
  }

  mapDelete(path: Path, key: string): Uint8Array {
    assertPath(path);
    assertKey(key);
    this.#mapAt(this.#doc.data, path);
    return this.#edit((d) => {
      delete this.#mapAt(d.data, path)[key];
    });
  }

  arrayInsert(path: Path, index: number, values: readonly Json[]): Uint8Array {
    assertPath(path);
    const vs = cloneJson(values) as Json[];
    assertIndex(index, this.#arrayAt(this.#doc.data, path).length, "index");
    return this.#edit((d) => {
      const list = this.#arrayAt(d.data, path);
      vs.forEach((v, j) => putInList(list, index + j, v));
    });
  }

  arrayDelete(path: Path, index: number, count: number): Uint8Array {
    assertPath(path);
    const len = this.#arrayAt(this.#doc.data, path).length;
    assertIndex(index, len, "index");
    assertIndex(count, len - index, "count");
    return this.#edit((d) => {
      this.#arrayAt(d.data, path).splice(index, count);
    });
  }

  getData(): { [key: string]: Json } {
    return JSON.parse(JSON.stringify(this.#doc.data)) as { [key: string]: Json };
  }


  applyUpdate(update: Uint8Array): void {
    this.#doc = A.loadIncremental(this.#doc, update);
  }

  encodeStateVector(): Uint8Array {
    return encodeHeads(A.getHeads(this.#doc));
  }

  encodeDiff(stateVector: Uint8Array): Uint8Array {
    const theirs = decodeHeads(stateVector).filter((h) => A.hasHeads(this.#doc, [h]));
    return A.saveSince(this.#doc, theirs);
  }

  snapshot(): Uint8Array {
    return A.save(this.#doc);
  }

  destroy(): void {
    A.free(this.#doc);
  }
}

export const automergeEngine: SyncEngine = {
  name: "automerge",
  create: (actor) => new AutomergeDoc(actor),
  load: (snapshot, actor) => new AutomergeDoc(actor, snapshot),
};
