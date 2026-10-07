/**
 * The engine boundary. Everything above this interface (gateway, SDK, ledger)
 * treats updates and state vectors as opaque bytes, so the Week 2 spike can
 * swap Yjs, Automerge or Loro without touching the rest of the system.
 *
 * Every document has one shared text field ("text") and one JSON-shaped data
 * tree rooted at a map ("data"): nested maps and arrays that merge cell by cell
 * (spec: docs/specs/engine-structured.md).
 */

export type EngineName = "yjs" | "automerge" | "loro";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** Keys into maps and indices into arrays, starting at the root map `data`. `[]` is the root. */
export type Path = readonly (string | number)[];

export interface EngineDoc {
  readonly engine: EngineName;
  /** Local edit. Returns the update bytes to broadcast (one per call). */
  insertText(index: number, text: string): Uint8Array;
  /** Local edit. Returns the update bytes to broadcast. */
  deleteText(index: number, length: number): Uint8Array;
  getText(): string;
  /** Sets `key` in the map at `path`, replacing any value. Returns the update bytes. */
  mapSet(path: Path, key: string, value: Json): Uint8Array;
  /** Removes `key` from the map at `path`; a missing key is a no-op that still returns a valid update. */
  mapDelete(path: Path, key: string): Uint8Array;
  /** Inserts `values` at `index` (0..length) in the array at `path`. Returns the update bytes. */
  arrayInsert(path: Path, index: number, values: readonly Json[]): Uint8Array;
  /** Removes `count` items starting at `index` from the array at `path`. Returns the update bytes. */
  arrayDelete(path: Path, index: number, count: number): Uint8Array;
  /** A deep copy of the data tree. */
  getData(): { [key: string]: Json };
  /** Applies a remote update or diff. Idempotent and order-independent. */
  applyUpdate(update: Uint8Array): void;
  /** Compact summary of what this replica has seen (SYNC_1 payload). */
  encodeStateVector(): Uint8Array;
  /** Everything this replica has that the holder of `stateVector` lacks (SYNC_2 payload). */
  encodeDiff(stateVector: Uint8Array): Uint8Array;
  /** Full state for persistence and cold load. */
  snapshot(): Uint8Array;
  destroy(): void;
}

export interface SyncEngine {
  readonly name: EngineName;
  /** `actor` must be unique per replica and positive. */
  create(actor: number): EngineDoc;
  load(snapshot: Uint8Array, actor: number): EngineDoc;
}

export function assertActor(actor: number): void {
  if (!Number.isSafeInteger(actor) || actor <= 0 || actor > 0xffff_ffff) {
    throw new RangeError(`actor must be an integer in 1..2^32-1, got ${actor}`);
  }
}

export function clampRange(len: number, index: number, count = 0): void {
  if (!Number.isInteger(index) || index < 0 || index > len) {
    throw new RangeError(`index ${index} outside 0..${len}`);
  }
  if (!Number.isInteger(count) || count < 0 || index + count > len) {
    throw new RangeError(`range ${index}+${count} outside 0..${len}`);
  }
}

const MAX_DEPTH = 32;
const MAX_NODES = 100_000;
const wellFormed = (s: string): boolean => (s as string & { isWellFormed(): boolean }).isWellFormed();

/** A map key or path step that is a string. `__proto__` is refused everywhere so no engine ever builds an object with it. */
export function assertKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !wellFormed(key) || key === "__proto__") {
    throw new RangeError("key must be a well-formed string and not __proto__");
  }
}

export function assertPath(path: Path): void {
  if (!Array.isArray(path)) throw new RangeError("path must be an array");
  for (const step of path) {
    if (typeof step === "number") {
      // A negative or too-large index simply fails to resolve to a container, which is refused the same way.
      if (!Number.isSafeInteger(step)) throw new RangeError(`path index ${step} is not an integer`);
    } else assertKey(step);
  }
}

export function assertIndex(index: number, max: number, what: string): void {
  if (!Number.isSafeInteger(index) || index < 0 || index > max) throw new RangeError(`${what} ${index} outside 0..${max}`);
}

/**
 * Validates a value and returns a private deep copy of it. Engines only ever see the copy, so a getter,
 * a proxy or a later mutation by the caller cannot make an edit differ from what was checked.
 * Throws RangeError for anything that is not plain JSON (spec rule 3).
 */
export function cloneJson(value: unknown): Json {
  let nodes = 0;
  const walk = (v: unknown, depth: number): Json => {
    if (++nodes > MAX_NODES) throw new RangeError("value has too many nodes");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new RangeError("numbers must be finite");
      return v;
    }
    if (typeof v === "string") {
      if (!wellFormed(v)) throw new RangeError("strings must be well-formed Unicode");
      return v;
    }
    if (typeof v !== "object") throw new RangeError(`${typeof v} is not JSON`);
    if (depth >= MAX_DEPTH) throw new RangeError("value is nested too deeply");
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype) throw new RangeError("only plain arrays are allowed");
      const out: Json[] = [];
      for (let i = 0; i < v.length; i++) {
        out.push(walk((v as unknown[])[i], depth + 1));
      }
      return out;
    }
    const proto = Object.getPrototypeOf(v) as unknown;
    if (proto !== Object.prototype && proto !== null) throw new RangeError("only plain objects are allowed");
    if (Object.getOwnPropertySymbols(v).length > 0) throw new RangeError("symbol keys are not allowed");
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(v)) {
      assertKey(key);
      // Read the value without running a getter: an accessor has no `value`, so it is refused as undefined.
      out[key] = walk((Object.getOwnPropertyDescriptor(v, key) as PropertyDescriptor).value, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}
