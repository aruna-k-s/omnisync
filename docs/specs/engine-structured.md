# Spec: structured data in the engine interface (Phase 1, week 7a)

Status: written before code. Decision D7 (extend the engine interface for maps and arrays in week 7) accepted as recommended.
Protected paths touched: none. `packages/engine` is not on the protected list; updates stay opaque bytes above it.

## Purpose

Phase 0 exposed one shared text field. The reference workbook needs rows, cells and lists, so every replica also carries one JSON-shaped tree next to the text. This week adds it to the interface and the three adapters. Everything above the engine (gateway, ledger, SDK transport) is unchanged: an edit is still one opaque update, signed, chained and replayed the same way.

## Model

Each document has two shared things:

- the text field `text` (unchanged), and
- a data tree rooted at a map `data`. Values are JSON: `null`, booleans, finite numbers, strings, arrays and plain objects. Arrays and objects are real nested shared containers, so two people editing different cells of one row, or inserting into one list, merge instead of overwriting each other.

```ts
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Path = readonly (string | number)[]; // keys into maps, indices into arrays; [] is the root map

interface EngineDoc {
  // existing text methods ...
  /** Sets key in the map at `path`. Replaces any value there. Returns the update bytes. */
  mapSet(path: Path, key: string, value: Json): Uint8Array;
  /** Removes key from the map at `path`. Returns the update bytes. */
  mapDelete(path: Path, key: string): Uint8Array;
  /** Inserts values at index in the array at `path`. Returns the update bytes. */
  arrayInsert(path: Path, index: number, values: readonly Json[]): Uint8Array;
  /** Removes `count` items starting at index from the array at `path`. Returns the update bytes. */
  arrayDelete(path: Path, index: number, count: number): Uint8Array;
  /** A deep copy of the whole tree. */
  getData(): { [key: string]: Json };
}
```

One call is one update: the caller signs and sends it exactly as it does a text edit.

## Rules

1. `path` must lead to a container of the right kind: `mapSet` and `mapDelete` need a map, `arrayInsert` and `arrayDelete` need an array. A missing step, an index out of range, or the wrong kind of container throws `RangeError` and changes nothing.
2. `index` is `0..length` for insert, and `index + count <= length` for delete (same as text).
3. Values are validated before anything changes. Refused with `RangeError`: `undefined`, `NaN`, `Infinity`, `bigint`, functions, symbols, class instances (anything but a plain object or array), sparse arrays, nesting deeper than 32 levels, more than 100,000 nodes in one value, and any key named `__proto__`. Keys may otherwise be any string, including the empty string. Strings must be well-formed Unicode.
4. `mapDelete` of a key that does not exist is a no-op that still returns a valid (empty) update. `arrayDelete` with `count = 0` likewise.
5. `getData()` returns plain objects with ordinary prototypes. A key named `constructor` or `toString` is just a key.
6. Concurrent writes to the same map key converge to one winner, the same on every replica. Which winner is the engine's business and is not part of the contract. Concurrent array inserts all survive.
7. Replaying any update, in any order, any number of times, leaves `getText()` and `getData()` unchanged after the first delivery (convergence, the property the text field already has).
8. `snapshot()`, `load()`, `encodeStateVector()` and `encodeDiff()` carry text and data together.
9. Numbers round-trip as numbers. An integer such as `3` may be stored as an integer and `3.5` as a float; the contract is that `getData()` returns the same JavaScript number.

## What this does not do

- No text inside the data tree (a rich cell). The root `text` field stays the only text; a collaborative cell is a Phase 2 question.
- No move operation for arrays, no counters, no tables as a built-in type: a table is an array of maps, which the workbook builds on this.
- No schema. Validation of payloads before apply is a separate Phase 2 item.

## Failure modes

| Input | Behaviour |
| --- | --- |
| Path does not resolve, wrong container kind, index out of range | `RangeError`, nothing changed |
| Value not JSON, too deep, too large, `__proto__` key | `RangeError`, nothing changed |
| Update bytes from an old snapshot (no data tree) | Applied; the data tree is created lazily by the engine's own rules; text unaffected |
| Hostile update bytes | Whatever the engine does today (the gateway validates and counts before apply; unchanged) |

## Tests (written first)

Shared by all three engines:

- Scenario tests for every method, including nested paths and every refusal in rules 1 to 3.
- Property: three replicas make random structured and text edits, deliver every update to every other replica in a shuffled order with duplicates, and end with equal `getText()` and `getData()`.
- Property: `encodeDiff(stateVector)` after concurrent edits brings a stale replica level, data included.
- Property: `snapshot()` then `load()` returns equal text and data and keeps accepting edits that converge with the original.
- Concurrent writes to one key converge to one value; concurrent inserts into one array keep every item.
- Prototype safety: keys `constructor`, `toString`, `hasOwnProperty`, and a refused `__proto__`.
- Gateway: two clients edit text and data through the real gateway and a cold load rebuilds both (the ledger sees opaque updates, so it needs no new test), and a refused edit signs and stores nothing.
