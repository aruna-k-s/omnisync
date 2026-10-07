import { LoroDoc, LoroList, LoroMap, VersionVector, type LoroText } from "loro-crdt";
import { assertActor, assertIndex, assertKey, assertPath, clampRange, cloneJson, type EngineDoc, type Json, type Path, type SyncEngine } from "./types.js";

/** Puts a copy of `v` at `key` of `map`. Maps and arrays become real nested containers so they merge cell by cell. */
function setIn(map: LoroMap, key: string, v: Json): void {
  if (Array.isArray(v)) {
    const l = map.setContainer(key, new LoroList());
    v.forEach((x, i) => insertIn(l, i, x));
  } else if (v !== null && typeof v === "object") {
    const m = map.setContainer(key, new LoroMap());
    for (const [k, x] of Object.entries(v)) setIn(m, k, x);
  } else map.set(key, v);
}

function insertIn(list: LoroList, index: number, v: Json): void {
  if (Array.isArray(v)) {
    const l = list.insertContainer(index, new LoroList());
    v.forEach((x, i) => insertIn(l, i, x));
  } else if (v !== null && typeof v === "object") {
    const m = list.insertContainer(index, new LoroMap());
    for (const [k, x] of Object.entries(v)) setIn(m, k, x);
  } else list.insert(index, v);
}

class LoroEngineDoc implements EngineDoc {
  readonly engine = "loro" as const;
  readonly #doc: LoroDoc;
  readonly #text: LoroText;
  readonly #data: LoroMap;

  constructor(actor: number, snapshot?: Uint8Array) {
    assertActor(actor);
    this.#doc = new LoroDoc();
    if (snapshot) this.#doc.import(snapshot);
    this.#doc.setPeerId(BigInt(actor));
    this.#text = this.#doc.getText("text");
    this.#data = this.#doc.getMap("data");
  }

  #capture(fn: () => void): Uint8Array {
    const before = this.#doc.oplogVersion();
    fn();
    this.#doc.commit();
    return this.#doc.export({ mode: "update", from: before });
  }

  #at(path: Path): LoroMap | LoroList {
    assertPath(path);
    let cur: unknown = this.#data;
    for (const step of path) {
      if (cur instanceof LoroMap && typeof step === "string") cur = cur.get(step);
      else if (cur instanceof LoroList && typeof step === "number") cur = cur.get(step);
      else throw new RangeError("path does not lead to a container");
    }
    if (cur instanceof LoroMap || cur instanceof LoroList) return cur;
    throw new RangeError("path does not lead to a map or an array");
  }

  #mapAt(path: Path): LoroMap {
    const c = this.#at(path);
    if (!(c instanceof LoroMap)) throw new RangeError("path leads to an array, not a map");
    return c;
  }

  #arrayAt(path: Path): LoroList {
    const c = this.#at(path);
    if (!(c instanceof LoroList)) throw new RangeError("path leads to a map, not an array");
    return c;
  }

  mapSet(path: Path, key: string, value: Json): Uint8Array {
    assertKey(key);
    const v = cloneJson(value);
    const m = this.#mapAt(path);
    return this.#capture(() => setIn(m, key, v));
  }

  mapDelete(path: Path, key: string): Uint8Array {
    assertKey(key);
    const m = this.#mapAt(path);
    return this.#capture(() => m.delete(key));
  }

  arrayInsert(path: Path, index: number, values: readonly Json[]): Uint8Array {
    const vs = cloneJson(values) as Json[];
    const l = this.#arrayAt(path);
    assertIndex(index, l.length, "index");
    return this.#capture(() => vs.forEach((v, j) => insertIn(l, index + j, v)));
  }

  arrayDelete(path: Path, index: number, count: number): Uint8Array {
    const l = this.#arrayAt(path);
    assertIndex(index, l.length, "index");
    assertIndex(count, l.length - index, "count");
    return this.#capture(() => l.delete(index, count));
  }

  getData(): { [key: string]: Json } {
    return this.#data.toJSON() as { [key: string]: Json };
  }

  insertText(index: number, text: string): Uint8Array {
    clampRange(this.#text.length, index);
    return this.#capture(() => this.#text.insert(index, text));
  }

  deleteText(index: number, length: number): Uint8Array {
    clampRange(this.#text.length, index, length);
    return this.#capture(() => this.#text.delete(index, length));
  }

  getText(): string {
    return this.#text.toString();
  }

  applyUpdate(update: Uint8Array): void {
    this.#doc.import(update);
  }

  encodeStateVector(): Uint8Array {
    return this.#doc.oplogVersion().encode();
  }

  encodeDiff(stateVector: Uint8Array): Uint8Array {
    return this.#doc.export({ mode: "update", from: VersionVector.decode(stateVector) });
  }

  snapshot(): Uint8Array {
    return this.#doc.export({ mode: "snapshot" });
  }

  destroy(): void {
    this.#doc.free();
  }
}

export const loroEngine: SyncEngine = {
  name: "loro",
  create: (actor) => new LoroEngineDoc(actor),
  load: (snapshot, actor) => new LoroEngineDoc(actor, snapshot),
};
