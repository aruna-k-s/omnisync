import * as A from "@automerge/automerge";
import { assertActor, clampRange, type EngineDoc, type SyncEngine } from "./types.js";

interface Shape {
  text: string;
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
