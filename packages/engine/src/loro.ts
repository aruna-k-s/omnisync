import { LoroDoc, VersionVector, type LoroText } from "loro-crdt";
import { assertActor, clampRange, type EngineDoc, type SyncEngine } from "./types.js";

class LoroEngineDoc implements EngineDoc {
  readonly engine = "loro" as const;
  readonly #doc: LoroDoc;
  readonly #text: LoroText;

  constructor(actor: number, snapshot?: Uint8Array) {
    assertActor(actor);
    this.#doc = new LoroDoc();
    if (snapshot) this.#doc.import(snapshot);
    this.#doc.setPeerId(BigInt(actor));
    this.#text = this.#doc.getText("text");
  }

  #capture(fn: () => void): Uint8Array {
    const before = this.#doc.oplogVersion();
    fn();
    this.#doc.commit();
    return this.#doc.export({ mode: "update", from: before });
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
