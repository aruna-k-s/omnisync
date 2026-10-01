/**
 * The engine boundary. Everything above this interface (gateway, SDK, ledger)
 * treats updates and state vectors as opaque bytes, so the Week 2 spike can
 * swap Yjs, Automerge or Loro without touching the rest of the system.
 *
 * Phase 0 exposes one shared text field ("text"); tables and maps arrive with
 * the reference workbook in Phase 1.
 */

export type EngineName = "yjs" | "automerge" | "loro";

export interface EngineDoc {
  readonly engine: EngineName;
  /** Local edit. Returns the update bytes to broadcast (one per call). */
  insertText(index: number, text: string): Uint8Array;
  /** Local edit. Returns the update bytes to broadcast. */
  deleteText(index: number, length: number): Uint8Array;
  getText(): string;
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
