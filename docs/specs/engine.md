# Spec: engine interface

**Purpose.** Keep the collaboration engine swappable until the Week 2 spike decides, and isolate it afterwards.

## Interface

`SyncEngine { name; create(actor); load(snapshot, actor) }` returns an `EngineDoc` with `insertText`, `deleteText` (each returns the update bytes to broadcast), `getText`, `applyUpdate`, `encodeStateVector`, `encodeDiff(stateVector)`, `snapshot`, `destroy`. Updates and state vectors are opaque bytes to everything above this package.

Adapters: Yjs (update format v2), Automerge 3 (state vector = sorted heads; all replicas share one base change so the text object id matches), Loro (version vector).

## Invariants

1. Replicas that receive the same set of updates converge, regardless of order or duplicates.
2. `b.applyUpdate(a.encodeDiff(b.encodeStateVector()))` brings `b` up to date with `a`.
3. `load(snapshot())` reproduces the text and keeps accepting edits.
4. Out-of-range edits throw `RangeError` before touching the document.

## Out of scope

Rich text, tables and maps arrive with the reference workbook (Phase 1, week 8).
