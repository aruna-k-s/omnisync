import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BranchError, type BranchRecord, type BranchState } from "./branch.js";

export interface BranchFilter {
  readonly mainDocId?: string;
  readonly agentId?: string;
  readonly state?: BranchState;
}

/**
 * Where branch records live in the prototype (docs/specs/shadow-branch.md, D13). Keyed by the branch's document id.
 * Every transition appends to `history`, so its length is the record's version: a save is accepted only on top of the
 * version the caller read, and a stale writer gets `conflict` instead of overwriting a newer decision.
 */
export interface BranchStore {
  get(branchDocId: string): Promise<BranchRecord | undefined>;
  save(record: BranchRecord): Promise<void>;
  list(filter?: BranchFilter): Promise<BranchRecord[]>;
}

function checkVersion(stored: BranchRecord | undefined, next: BranchRecord): void {
  const have = stored?.history.length ?? 0;
  if (next.history.length !== have + 1) throw new BranchError("conflict", `stored version ${have}, saving ${next.history.length}`);
}

const matches = (r: BranchRecord, f: BranchFilter): boolean =>
  (f.mainDocId === undefined || r.mainDocId === f.mainDocId) && (f.agentId === undefined || r.agentId === f.agentId) && (f.state === undefined || r.state === f.state);

const byCreated = (a: BranchRecord, b: BranchRecord): number => a.createdAtMs - b.createdAtMs || (a.branchDocId < b.branchDocId ? -1 : 1);

export class MemoryBranchStore implements BranchStore {
  readonly #records = new Map<string, BranchRecord>();

  async get(branchDocId: string): Promise<BranchRecord | undefined> {
    const r = this.#records.get(branchDocId);
    return r ? structuredClone(r) : undefined;
  }

  async save(record: BranchRecord): Promise<void> {
    checkVersion(this.#records.get(record.branchDocId), record);
    this.#records.set(record.branchDocId, structuredClone(record));
  }

  async list(filter: BranchFilter = {}): Promise<BranchRecord[]> {
    return [...this.#records.values()].filter((r) => matches(r, filter)).map((r) => structuredClone(r)).sort(byCreated);
  }
}

const BYTES = "$bytes";
const replacer = (_k: string, v: unknown): unknown => (v instanceof Uint8Array ? { [BYTES]: Buffer.from(v).toString("hex") } : v);
const reviver = (_k: string, v: unknown): unknown => {
  if (v !== null && typeof v === "object" && BYTES in v && typeof (v as Record<string, unknown>)[BYTES] === "string") {
    return new Uint8Array(Buffer.from((v as Record<string, string>)[BYTES] as string, "hex"));
  }
  return v;
};

/** One JSON file per branch in a directory. The file name is derived from the document id, never used as a path. */
export class FileBranchStore implements BranchStore {
  constructor(private readonly dir: string) {}

  #file(branchDocId: string): string {
    return join(this.dir, `${Buffer.from(branchDocId, "utf8").toString("base64url")}.json`);
  }

  async get(branchDocId: string): Promise<BranchRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.#file(branchDocId), "utf8"), reviver) as BranchRecord;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }

  async save(record: BranchRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    checkVersion(await this.get(record.branchDocId), record);
    const file = this.#file(record.branchDocId);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(record, replacer), { mode: 0o600 });
    await rename(tmp, file); // readers see the old record or the new one, never half of one
  }

  async list(filter: BranchFilter = {}): Promise<BranchRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const out: BranchRecord[] = [];
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      const r = JSON.parse(await readFile(join(this.dir, n), "utf8"), reviver) as BranchRecord;
      if (matches(r, filter)) out.push(r);
    }
    return out.sort(byCreated);
  }
}
