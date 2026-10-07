import * as Y from "yjs";
import { assertActor, assertIndex, assertKey, assertPath, clampRange, cloneJson, type EngineDoc, type Json, type Path, type SyncEngine } from "./types.js";

const EMPTY_UPDATE = Y.encodeStateAsUpdateV2(new Y.Doc());

/** A fresh shared container (not yet attached) holding a copy of `v`. Maps and arrays stay mergeable cell by cell. */
function toShared(v: Json): unknown {
  if (Array.isArray(v)) {
    const a = new Y.Array<unknown>();
    a.push(v.map(toShared));
    return a;
  }
  if (v !== null && typeof v === "object") {
    const m = new Y.Map<unknown>();
    for (const [k, x] of Object.entries(v)) m.set(k, toShared(x));
    return m;
  }
  return v;
}

/** Yjs adapter. Uses update format v2 on the wire, per the spec. */
class YjsDoc implements EngineDoc {
  readonly engine = "yjs" as const;
  readonly #doc: Y.Doc;
  readonly #text: Y.Text;
  readonly #data: Y.Map<unknown>;

  constructor(actor: number, snapshot?: Uint8Array) {
    assertActor(actor);
    this.#doc = new Y.Doc({ gc: true });
    this.#doc.clientID = actor;
    this.#text = this.#doc.getText("text");
    this.#data = this.#doc.getMap("data");
    if (snapshot) Y.applyUpdateV2(this.#doc, snapshot);
  }

  // Capture the transaction's own update. Diffing against a state vector
  // instead would resend the whole delete set on every keystroke.
  #capture(fn: () => void): Uint8Array {
    let captured: Uint8Array | undefined;
    const onUpdate = (update: Uint8Array) => {
      captured = update;
    };
    this.#doc.on("updateV2", onUpdate);
    try {
      this.#doc.transact(fn, "local");
    } finally {
      this.#doc.off("updateV2", onUpdate);
    }
    if (captured === undefined) throw new Error("edit produced no update");
    return captured;
  }

  /** Like #capture, but an edit that changes nothing (deleting a missing key) yields an empty update instead of an error. */
  #captureOrEmpty(fn: () => void): Uint8Array {
    let captured: Uint8Array | undefined;
    const onUpdate = (update: Uint8Array) => {
      captured = update;
    };
    this.#doc.on("updateV2", onUpdate);
    try {
      this.#doc.transact(fn, "local");
    } finally {
      this.#doc.off("updateV2", onUpdate);
    }
    return captured ?? EMPTY_UPDATE.slice();
  }

  #at(path: Path): Y.Map<unknown> | Y.Array<unknown> {
    assertPath(path);
    let cur: unknown = this.#data;
    for (const step of path) {
      if (cur instanceof Y.Map && typeof step === "string") cur = cur.get(step);
      else if (cur instanceof Y.Array && typeof step === "number") cur = cur.get(step);
      else throw new RangeError("path does not lead to a container");
    }
    if (cur instanceof Y.Map || cur instanceof Y.Array) return cur;
    throw new RangeError("path does not lead to a map or an array");
  }

  #mapAt(path: Path): Y.Map<unknown> {
    const c = this.#at(path);
    if (!(c instanceof Y.Map)) throw new RangeError("path leads to an array, not a map");
    return c;
  }

  #arrayAt(path: Path): Y.Array<unknown> {
    const c = this.#at(path);
    if (!(c instanceof Y.Array)) throw new RangeError("path leads to a map, not an array");
    return c;
  }

  mapSet(path: Path, key: string, value: Json): Uint8Array {
    assertKey(key);
    const v = cloneJson(value);
    const m = this.#mapAt(path);
    return this.#capture(() => m.set(key, toShared(v)));
  }

  mapDelete(path: Path, key: string): Uint8Array {
    assertKey(key);
    const m = this.#mapAt(path);
    return this.#captureOrEmpty(() => m.delete(key));
  }

  arrayInsert(path: Path, index: number, values: readonly Json[]): Uint8Array {
    const vs = cloneJson(values) as Json[];
    const a = this.#arrayAt(path);
    assertIndex(index, a.length, "index");
    if (vs.length === 0) return EMPTY_UPDATE.slice();
    return this.#capture(() => a.insert(index, vs.map(toShared)));
  }

  arrayDelete(path: Path, index: number, count: number): Uint8Array {
    const a = this.#arrayAt(path);
    assertIndex(index, a.length, "index");
    assertIndex(count, a.length - index, "count");
    return this.#captureOrEmpty(() => a.delete(index, count));
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
    Y.applyUpdateV2(this.#doc, update, "remote");
  }

  encodeStateVector(): Uint8Array {
    return Y.encodeStateVector(this.#doc);
  }

  encodeDiff(stateVector: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdateV2(this.#doc, stateVector);
  }

  snapshot(): Uint8Array {
    return Y.encodeStateAsUpdateV2(this.#doc);
  }

  destroy(): void {
    this.#doc.destroy();
  }
}

export const yjsEngine: SyncEngine = {
  name: "yjs",
  create: (actor) => new YjsDoc(actor),
  load: (snapshot, actor) => new YjsDoc(actor, snapshot),
};
