import { automergeEngine } from "./automerge.js";
import { loroEngine } from "./loro.js";
import type { EngineName, SyncEngine } from "./types.js";
import { yjsEngine } from "./yjs.js";

export * from "./types.js";
export { automergeEngine, loroEngine, yjsEngine };

export const engines: Readonly<Record<EngineName, SyncEngine>> = {
  yjs: yjsEngine,
  automerge: automergeEngine,
  loro: loroEngine,
};

export function getEngine(name: string): SyncEngine {
  if (name in engines) return engines[name as EngineName];
  throw new Error(`unknown engine "${name}"; expected one of ${Object.keys(engines).join(", ")}`);
}
