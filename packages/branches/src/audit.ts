import type { BranchRecord } from "./branch.js";
import type { MergeRecord } from "./merge.js";

/** Structurally an `AuditInput` of `@omnisync/store`'s identity store, so `appendAudit` takes it as is. */
export interface BranchAudit {
  readonly atMs: number;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly detail: string;
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * The audit entry for the last transition of a branch. Ids, numbers and hashes only: never document text, never the
 * names of the paths that changed (the audit trail is for who did what, the branch ledger holds the content).
 */
export function auditForTransition(b: BranchRecord): BranchAudit {
  const h = b.history[b.history.length - 1];
  if (!h) throw new Error("a branch always has a history");
  const proposal = b.proposals[b.proposals.length - 1];
  return {
    atMs: h.atMs,
    actor: h.by ?? "system",
    action: `branch.${h.event}`,
    target: b.branchDocId,
    detail: JSON.stringify({ branch: b.id, main: b.mainDocId, agent: b.agentId, state: b.state, ...(proposal ? { proposal: proposal.number, changes: proposal.changes.length } : {}) }),
  };
}

/** The entry that links main's human-signed edits to the agent's entries in the branch ledger (Merge model, option A). */
export function auditForMerge(m: MergeRecord): BranchAudit {
  return {
    atMs: m.approvedAtMs,
    actor: m.approvedBy,
    action: "branch.merge",
    target: m.mainDocId,
    detail: JSON.stringify({
      branch: m.branchDocId,
      agent: m.agentId,
      proposal: m.proposal,
      ...(m.secondApprover !== undefined ? { secondApprover: m.secondApprover, policyRole: m.policyRole } : {}),
      stepUp: m.stepUp,
      baseMainHeadSeq: m.baseMainHeadSeq,
      branchSeqs: [m.fromSeq, m.toSeq],
      entries: m.entryCount,
      headEntryHash: hex(m.headEntryHash),
      resolutions: m.resolvedPaths.length,
    }),
  };
}
