import type { Json } from "@omnisync/engine";
import type { Change } from "./classify.js";

/** Why a transition was refused. Stable strings: the console, the audit trail and the tests name them. */
export type BranchErrorCode =
  | "wrong_state"
  | "not_agent"
  | "not_authorized"
  | "self_merge"
  | "unresolved_overlap"
  | "not_an_overlap"
  | "second_approver_required"
  | "policy_role_unconfigured"
  | "nothing_to_propose"
  | "expired"
  | "frozen"
  | "ttl_too_long"
  | "bad_id"
  | "bad_path"
  | "bad_entries"
  | "conflict";

export class BranchError extends Error {
  override readonly name = "BranchError";
  constructor(
    readonly code: BranchErrorCode,
    message?: string,
  ) {
    super(message === undefined ? code : `${code}: ${message}`);
  }
}

/** A person's role on the MAIN document, as the identity store reports it (`none` when they have no grant). */
export type MainRole = "none" | "read" | "write" | "merge" | "admin";
const RANK: Record<MainRole, number> = { none: -1, read: 0, write: 1, merge: 2, admin: 3 };
const canMerge = (r: MainRole): boolean => RANK[r] >= RANK.merge;

export interface Actor {
  readonly principalId: string;
  readonly mainRole: MainRole;
  /** Named policy roles this person holds (for a second approval of review-required changes). */
  readonly policyRoles: readonly string[];
}

export type BranchState = "open" | "proposed" | "merged" | "rejected" | "archived" | "frozen";

export interface Proposal {
  readonly number: number;
  readonly summary: string;
  readonly by: string;
  readonly atMs: number;
  readonly changes: readonly Change[];
  /**
   * The branch document's head seq when the diff was computed. A merge applies the agent's entries up to this seq and
   * no further, so an edit the agent makes after the reviewer started looking is never merged unseen.
   */
  readonly branchHeadSeq?: number;
  readonly returnedWith?: string;
  readonly rejectedWith?: string;
}

export interface Approval {
  /** The number of the proposal this approval covers: always the latest, and always the whole of it. */
  readonly proposal: number;
  readonly by: string;
  readonly second?: string;
  readonly policyRole?: string;
  /** The reviewer's chosen value for each overlap. `undefined` means the reviewer chose removal. */
  readonly resolutions: Readonly<Record<string, Json | undefined>>;
  /** Passkey step-up is not built in the prototype; the record says so rather than implying it. */
  readonly stepUp: "none";
  readonly atMs: number;
}

export interface HistoryEntry {
  readonly atMs: number;
  readonly event: "fork" | "propose" | "return" | "reject" | "approve" | "expire" | "freeze";
  readonly by?: string;
}

export interface BranchBase {
  readonly mainHeadSeq: number;
  readonly mainHeadHash: Uint8Array;
  readonly stateVector: Uint8Array;
}

export interface BranchRecord {
  readonly id: string;
  readonly mainDocId: string;
  /** The branch is a document of its own: `<main>~b~<id>`. */
  readonly branchDocId: string;
  readonly agentId: string;
  readonly forkedBy: string;
  readonly purpose: string;
  readonly scope?: string;
  readonly base: BranchBase;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly state: BranchState;
  readonly proposals: readonly Proposal[];
  readonly approval?: Approval;
  readonly history: readonly HistoryEntry[];
}

const HOUR = 3_600_000;
export const DEFAULT_TTL_MS = 24 * HOUR;
export const DEFAULT_MAX_TTL_MS = 7 * 24 * HOUR;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isBranchId = (id: string): boolean => ID.test(id);

export const branchDocId = (mainDocId: string, id: string): string => `${mainDocId}~b~${id}`;

export interface ForkInput {
  readonly id: string;
  readonly mainDocId: string;
  readonly agentId: string;
  readonly forkedBy: Actor;
  readonly purpose: string;
  readonly scope?: string;
  readonly base: BranchBase;
  readonly nowMs: number;
  readonly ttlMs?: number;
  readonly maxTtlMs?: number;
}

export function fork(input: ForkInput): BranchRecord {
  if (!isBranchId(input.id)) throw new BranchError("bad_id", "1 to 64 letters, digits, '-' or '_'");
  if (input.forkedBy.principalId === input.agentId) throw new BranchError("self_merge", "an agent cannot fork its own branch");
  if (!canMerge(input.forkedBy.mainRole)) throw new BranchError("not_authorized", "forking needs merge on the main document");
  const ttl = input.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > (input.maxTtlMs ?? DEFAULT_MAX_TTL_MS)) throw new BranchError("ttl_too_long");
  return {
    id: input.id,
    mainDocId: input.mainDocId,
    branchDocId: branchDocId(input.mainDocId, input.id),
    agentId: input.agentId,
    forkedBy: input.forkedBy.principalId,
    purpose: input.purpose,
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    base: input.base,
    createdAtMs: input.nowMs,
    expiresAtMs: input.nowMs + ttl,
    state: "open",
    proposals: [],
    history: [{ atMs: input.nowMs, event: "fork", by: input.forkedBy.principalId }],
  };
}

const latest = (b: BranchRecord): Proposal => {
  const p = b.proposals[b.proposals.length - 1];
  if (!p) throw new BranchError("wrong_state", "no proposal");
  return p;
};

const refuseUnless = (b: BranchRecord, state: BranchState): void => {
  if (b.state === "frozen" && state !== "frozen") throw new BranchError("frozen");
  if (b.state !== state) throw new BranchError("wrong_state", `branch is ${b.state}, needs ${state}`);
};

const noteFor = (b: BranchRecord, e: HistoryEntry): readonly HistoryEntry[] => [...b.history, e];

export interface ProposeInput {
  readonly by: Actor;
  readonly summary: string;
  readonly changes: readonly Change[];
  /** The branch document's head seq the changes were computed at (see `Proposal.branchHeadSeq`). */
  readonly branchHeadSeq?: number;
  readonly nowMs: number;
}

export function propose(b: BranchRecord, input: ProposeInput): BranchRecord {
  refuseUnless(b, "open");
  if (input.nowMs >= b.expiresAtMs) throw new BranchError("expired");
  if (input.by.principalId !== b.agentId && input.by.principalId !== b.forkedBy) throw new BranchError("not_agent");
  if (input.changes.length === 0) throw new BranchError("nothing_to_propose");
  const proposal: Proposal = { number: b.proposals.length + 1, summary: input.summary, by: input.by.principalId, atMs: input.nowMs, changes: input.changes, ...(input.branchHeadSeq !== undefined ? { branchHeadSeq: input.branchHeadSeq } : {}) };
  return { ...b, state: "proposed", proposals: [...b.proposals, proposal], history: noteFor(b, { atMs: input.nowMs, event: "propose", by: input.by.principalId }) };
}

const withLatest = (b: BranchRecord, patch: Partial<Proposal>): readonly Proposal[] => b.proposals.map((p, i) => (i === b.proposals.length - 1 ? { ...p, ...patch } : p));

export function returnToAgent(b: BranchRecord, input: { by: Actor; comment: string; nowMs: number }): BranchRecord {
  refuseUnless(b, "proposed");
  if (!canMerge(input.by.mainRole)) throw new BranchError("not_authorized");
  latest(b);
  return { ...b, state: "open", proposals: withLatest(b, { returnedWith: input.comment }), history: noteFor(b, { atMs: input.nowMs, event: "return", by: input.by.principalId }) };
}

/** Rejecting is allowed from `proposed` and from `frozen`: a reviewer can always close a branch whose agent has been cut off. */
export function reject(b: BranchRecord, input: { by: Actor; reason: string; nowMs: number }): BranchRecord {
  if (b.state !== "proposed" && b.state !== "frozen") throw new BranchError("wrong_state", `branch is ${b.state}`);
  if (!canMerge(input.by.mainRole)) throw new BranchError("not_authorized");
  return {
    ...b,
    state: "rejected",
    proposals: b.proposals.length > 0 ? withLatest(b, { rejectedWith: input.reason }) : b.proposals,
    history: noteFor(b, { atMs: input.nowMs, event: "reject", by: input.by.principalId }),
  };
}

export interface ApproveInput {
  readonly by: Actor;
  readonly second?: Actor;
  /** The named role a second approver must hold when any change is review-required. */
  readonly policyRole?: string;
  readonly resolutions: Readonly<Record<string, Json | undefined>>;
  readonly nowMs: number;
}

/** Approves the whole latest proposal. There is no partial approval: Yjs updates depend on earlier ones. */
export function approve(b: BranchRecord, input: ApproveInput): BranchRecord {
  refuseUnless(b, "proposed");
  if (input.nowMs >= b.expiresAtMs) throw new BranchError("expired");
  const proposal = latest(b);
  const { by } = input;
  if (by.principalId === b.agentId) throw new BranchError("self_merge");
  if (!canMerge(by.mainRole)) throw new BranchError("not_authorized", "approving needs merge on the main document");

  const overlaps = new Set(proposal.changes.filter((c) => c.class === "overlap").map((c) => c.path));
  for (const path of Object.keys(input.resolutions)) if (!overlaps.has(path)) throw new BranchError("not_an_overlap", path);
  for (const path of overlaps) if (!Object.prototype.hasOwnProperty.call(input.resolutions, path)) throw new BranchError("unresolved_overlap", path);

  let second: string | undefined;
  if (proposal.changes.some((c) => c.policy)) {
    if (input.policyRole === undefined || input.policyRole === "") throw new BranchError("policy_role_unconfigured");
    const s = input.second;
    if (s === undefined) throw new BranchError("second_approver_required", "the proposal changes review-required paths");
    if (s.principalId === b.agentId) throw new BranchError("self_merge");
    if (s.principalId === by.principalId) throw new BranchError("second_approver_required", "must be a different person");
    if (!canMerge(s.mainRole)) throw new BranchError("second_approver_required", "needs merge on the main document");
    if (!s.policyRoles.includes(input.policyRole)) throw new BranchError("second_approver_required", `needs the ${input.policyRole} role`);
    second = s.principalId;
  }

  const approval: Approval = {
    proposal: proposal.number,
    by: by.principalId,
    ...(second !== undefined && input.policyRole !== undefined ? { second, policyRole: input.policyRole } : {}),
    resolutions: { ...input.resolutions },
    stepUp: "none",
    atMs: input.nowMs,
  };
  return { ...b, state: "merged", approval, history: noteFor(b, { atMs: input.nowMs, event: "approve", by: by.principalId }) };
}

/** Archives an open or proposed branch whose time is up. Archived means kept, not deleted. */
export function tick(b: BranchRecord, nowMs: number): BranchRecord {
  if ((b.state !== "open" && b.state !== "proposed") || nowMs < b.expiresAtMs) return b;
  return { ...b, state: "archived", history: noteFor(b, { atMs: nowMs, event: "expire" }) };
}

/** The kill switch: the agent's key was revoked. Its open and proposed branches stop; finished ones are left alone. */
export function freeze(b: BranchRecord, input: { agentId: string; nowMs: number }): BranchRecord {
  if (b.agentId !== input.agentId || (b.state !== "open" && b.state !== "proposed")) return b;
  return { ...b, state: "frozen", history: noteFor(b, { atMs: input.nowMs, event: "freeze" }) };
}
