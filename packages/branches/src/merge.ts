import type { EngineDoc, Json } from "@omnisync/engine";
import { BranchError, type BranchRecord } from "./branch.js";
import { TEXT_PATH } from "./classify.js";

/** One entry of the branch document's ledger after the seeding update: the agent's signed edit, as the engine update it carries. */
export interface BranchEntry {
  readonly seq: number;
  readonly entryHash: Uint8Array;
  readonly payload: Uint8Array;
}

export interface Resolution {
  readonly path: string;
  /** `undefined` removes the key. */
  readonly value: Json | undefined;
}

/** What is written to the audit trail when a branch is merged: it links main's human-signed edits to the agent's ledger. */
export interface MergeRecord {
  readonly branchId: string;
  readonly branchDocId: string;
  readonly mainDocId: string;
  readonly agentId: string;
  readonly purpose: string;
  readonly proposal: number;
  readonly approvedBy: string;
  readonly secondApprover?: string;
  readonly policyRole?: string;
  readonly approvedAtMs: number;
  readonly stepUp: "none";
  readonly baseMainHeadSeq: number;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly entryCount: number;
  readonly headEntryHash: Uint8Array;
  readonly entryHashes: readonly Uint8Array[];
  readonly resolvedPaths: readonly string[];
}

export interface MergePlan {
  /** The agent's engine updates, in branch order, byte for byte. The merging human signs each as an UPDATE on main. */
  readonly updates: readonly Uint8Array[];
  /** The reviewer's values for overlaps, applied after `updates` as the human's own edits. Sorted by path. */
  readonly resolutions: readonly Resolution[];
  readonly record: MergeRecord;
}

/** The first entry of a branch document is the forking human's seeding update; the agent's edits start at seq 2. */
export const FIRST_AGENT_SEQ = 2;

/**
 * What has to happen on main for an approved branch (docs/specs/shadow-branch.md, Merge model, option A). Pure: it applies
 * nothing and signs nothing. The caller signs `updates` and the human's resolutions as UPDATE frames on main.
 */
export function planMerge(b: BranchRecord, given: readonly BranchEntry[]): MergePlan {
  const approval = b.approval;
  if (b.state !== "merged" || approval === undefined) throw new BranchError("wrong_state", `branch is ${b.state}, needs an approval`);
  const proposal = b.proposals.find((p) => p.number === approval.proposal);
  if (proposal === undefined) throw new BranchError("wrong_state", "approval names a proposal the branch does not have");

  // Only what the reviewer was shown: entries after the reviewed head are not merged, and their absence is not an error.
  const entries = given.filter((e) => proposal.branchHeadSeq === undefined || e.seq <= proposal.branchHeadSeq).sort((a, c) => a.seq - c.seq);
  if (entries.length === 0) throw new BranchError("bad_entries", "no entries to merge");
  entries.forEach((e, i) => {
    if (i === 0) {
      if (e.seq !== FIRST_AGENT_SEQ) throw new BranchError("bad_entries", `entries must start at seq ${FIRST_AGENT_SEQ}, after the seeding update`);
    } else {
      const prev = (entries[i - 1] as BranchEntry).seq;
      if (e.seq === prev) throw new BranchError("bad_entries", `repeat of seq ${e.seq}`);
      if (e.seq !== prev + 1) throw new BranchError("bad_entries", `gap between seq ${prev} and ${e.seq}`);
    }
  });
  const last = entries[entries.length - 1] as BranchEntry;
  if (proposal.branchHeadSeq !== undefined && last.seq !== proposal.branchHeadSeq) {
    throw new BranchError("bad_entries", `entries end at seq ${last.seq}, the reviewed head is ${proposal.branchHeadSeq}`);
  }

  const resolutions = Object.entries(approval.resolutions)
    .map(([path, value]) => ({ path, value }))
    .sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return {
    updates: entries.map((e) => e.payload),
    resolutions,
    record: {
      branchId: b.id,
      branchDocId: b.branchDocId,
      mainDocId: b.mainDocId,
      agentId: b.agentId,
      purpose: b.purpose,
      proposal: approval.proposal,
      approvedBy: approval.by,
      ...(approval.second !== undefined ? { secondApprover: approval.second } : {}),
      ...(approval.policyRole !== undefined ? { policyRole: approval.policyRole } : {}),
      approvedAtMs: approval.atMs,
      stepUp: approval.stepUp,
      baseMainHeadSeq: b.base.mainHeadSeq,
      fromSeq: (entries[0] as BranchEntry).seq,
      toSeq: last.seq,
      entryCount: entries.length,
      headEntryHash: last.entryHash,
      entryHashes: entries.map((e) => e.entryHash),
      resolvedPaths: resolutions.map((r) => r.path),
    },
  };
}

const unescapeKey = (k: string): string => k.replace(/~1/g, "/").replace(/~0/g, "~");

/**
 * Applies the reviewer's values to a document and returns the engine updates, one per resolution, for the human to sign.
 * Paths are JSON pointers into maps (the classifier never reports a path through an array) or `$text`.
 */
export function applyResolutions(doc: EngineDoc, resolutions: readonly Resolution[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const { path, value } of resolutions) {
    if (path === TEXT_PATH) {
      if (typeof value !== "string") throw new BranchError("bad_path", "the text can only be replaced by a string");
      const length = doc.getText().length;
      if (length > 0) out.push(doc.deleteText(0, length));
      if (value !== "") out.push(doc.insertText(0, value));
      continue;
    }
    if (!path.startsWith("/") || path === "/") throw new BranchError("bad_path", path);
    const segments = path.slice(1).split("/").map(unescapeKey);
    const key = segments[segments.length - 1] as string;
    const parent = segments.slice(0, -1);
    try {
      out.push(value === undefined ? doc.mapDelete(parent, key) : doc.mapSet(parent, key, value));
    } catch (e) {
      throw new BranchError("bad_path", `${path}: ${e instanceof Error ? e.message : "not a map"}`);
    }
  }
  return out;
}
