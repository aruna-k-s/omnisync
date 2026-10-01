import * as Y from "yjs";
import { assertActor, clampRange, type EngineDoc, type SyncEngine } from "./types.js";

/** Yjs adapter. Uses update format v2 on the wire, per the spec. */
class YjsDoc implements EngineDoc {
  readonly engine = "yjs" as const;
  readonly #doc: Y.Doc;
  readonly #text: Y.Text;

  constructor(actor: number, snapshot?: Uint8Array) {
    assertActor(actor);
    this.#doc = new Y.Doc({ gc: true });
    this.#doc.clientID = actor;
    this.#text = this.#doc.getText("text");
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
