import { describe, expect, it } from "vitest";
import {
  BranchError,
  approve,
  freeze,
  fork,
  propose,
  reject,
  returnToAgent,
  tick,
  type Actor,
  type BranchRecord,
  type Change,
} from "../src/index.js";

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000;
const alice: Actor = { principalId: "alice", mainRole: "merge", policyRoles: [] };
const bob: Actor = { principalId: "bob", mainRole: "merge", policyRoles: ["finance"] };
const carol: Actor = { principalId: "carol", mainRole: "write", policyRoles: [] };
const agent: Actor = { principalId: "agent-1", mainRole: "none", policyRoles: [] };

const clean: Change = { path: "/title", change: "changed", class: "clean", policy: false };
const overlap: Change = { path: "/limits/max", change: "changed", class: "overlap", policy: false };
const policy: Change = { path: "/limits/min", change: "changed", class: "clean", policy: true };

const forked = (over: Partial<Parameters<typeof fork>[0]> = {}): BranchRecord =>
  fork({
    id: "b1",
    mainDocId: "doc",
    agentId: "agent-1",
    forkedBy: alice,
    purpose: "Draft section 3",
    base: { mainHeadSeq: 10, mainHeadHash: new Uint8Array(32).fill(7), stateVector: new Uint8Array([1, 2, 3]) },
    nowMs: T0,
    ...over,
  });
const proposed = (changes: Change[] = [clean], b = forked()) => propose(b, { by: agent, summary: "s", changes, nowMs: T0 + 1000 });
const fail = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BranchError);
    expect((e as BranchError).code).toBe(code);
    return;
  }
  throw new Error(`expected BranchError ${code}`);
};

describe("fork", () => {
  it("records the base, the agent, the purpose, and a 24 hour expiry by default", () => {
    const b = forked();
    expect(b).toMatchObject({ id: "b1", mainDocId: "doc", agentId: "agent-1", state: "open", purpose: "Draft section 3", forkedBy: "alice", createdAtMs: T0, expiresAtMs: T0 + 24 * HOUR });
    expect(b.branchDocId).toBe("doc~b~b1");
    expect(b.base.mainHeadSeq).toBe(10);
    expect(b.proposals).toEqual([]);
  });
  it("needs merge on main", () => {
    fail(() => forked({ forkedBy: carol }), "not_authorized");
  });
  it("honours a shorter time limit and refuses one beyond the configured maximum", () => {
    expect(forked({ ttlMs: HOUR }).expiresAtMs).toBe(T0 + HOUR);
    fail(() => forked({ ttlMs: 100 * HOUR, maxTtlMs: 48 * HOUR }), "ttl_too_long");
  });
  it("refuses an id that would make a document id ambiguous", () => {
    for (const id of ["", "a b", "a/b", "a~b", "x".repeat(65)]) fail(() => forked({ id }), "bad_id");
  });
  it("does not let the agent be the person who forks it", () => {
    fail(() => forked({ forkedBy: { ...alice, principalId: "agent-1" } }), "self_merge");
  });
});

describe("propose", () => {
  it("moves open to proposed and numbers the proposal", () => {
    const b = proposed();
    expect(b.state).toBe("proposed");
    expect(b.proposals).toHaveLength(1);
    expect(b.proposals[0]).toMatchObject({ number: 1, summary: "s", by: "agent-1", changes: [clean] });
  });
  it("is for the branch's agent or the person who forked it, nobody else", () => {
    fail(() => propose(forked(), { by: bob, summary: "s", changes: [clean], nowMs: T0 }), "not_agent");
    expect(propose(forked(), { by: alice, summary: "s", changes: [clean], nowMs: T0 }).state).toBe("proposed");
  });
  it("refuses a branch that differs from its base in nothing", () => {
    fail(() => proposed([]), "nothing_to_propose");
  });
  it("refuses once expired, even before the next tick", () => {
    fail(() => propose(forked(), { by: agent, summary: "s", changes: [clean], nowMs: T0 + 24 * HOUR }), "expired");
    expect(propose(forked(), { by: agent, summary: "s", changes: [clean], nowMs: T0 + 24 * HOUR - 1 }).state).toBe("proposed");
  });
  it("is refused from any state but open", () => {
    fail(() => proposed([clean], proposed()), "wrong_state");
  });
});

describe("return and a superseding proposal", () => {
  it("returns to open with the comment kept, and a second proposal is number 2", () => {
    const r = returnToAgent(proposed(), { by: bob, comment: "tighten", nowMs: T0 + 2000 });
    expect(r.state).toBe("open");
    expect(r.proposals[0]?.returnedWith).toBe("tighten");
    const again = propose(r, { by: agent, summary: "v2", changes: [clean], nowMs: T0 + 3000 });
    expect(again.proposals.map((p) => p.number)).toEqual([1, 2]);
    expect(again.state).toBe("proposed");
  });
  it("needs merge on main", () => {
    fail(() => returnToAgent(proposed(), { by: carol, comment: "x", nowMs: T0 }), "not_authorized");
  });
  it("only a proposed branch can be returned", () => {
    fail(() => returnToAgent(forked(), { by: bob, comment: "x", nowMs: T0 }), "wrong_state");
  });
});

describe("reject", () => {
  it("is terminal and keeps the branch and the reason", () => {
    const r = reject(proposed(), { by: bob, reason: "wrong tone", nowMs: T0 + 2000 });
    expect(r.state).toBe("rejected");
    expect(r.proposals[0]?.rejectedWith).toBe("wrong tone");
    fail(() => propose(r, { by: agent, summary: "s", changes: [clean], nowMs: T0 }), "wrong_state");
  });
  it("needs merge on main and a proposal to reject", () => {
    fail(() => reject(proposed(), { by: agent, reason: "x", nowMs: T0 }), "not_authorized");
    fail(() => reject(forked(), { by: bob, reason: "x", nowMs: T0 }), "wrong_state");
  });
});

describe("approve", () => {
  it("merges a proposal of clean changes", () => {
    const m = approve(proposed(), { by: bob, resolutions: {}, nowMs: T0 + 2000 });
    expect(m.state).toBe("merged");
    expect(m.approval).toMatchObject({ proposal: 1, by: "bob", stepUp: "none", resolutions: {} });
    expect(m.approval?.second).toBeUndefined();
  });
  it("is never the agent, and never someone without merge on main", () => {
    fail(() => approve(proposed(), { by: agent, resolutions: {}, nowMs: T0 }), "self_merge");
    fail(() => approve(proposed(), { by: { ...alice, principalId: "agent-1" }, resolutions: {}, nowMs: T0 }), "self_merge");
    fail(() => approve(proposed(), { by: carol, resolutions: {}, nowMs: T0 }), "not_authorized");
  });
  it("needs a chosen value for every overlap", () => {
    fail(() => approve(proposed([clean, overlap]), { by: bob, resolutions: {}, nowMs: T0 }), "unresolved_overlap");
    const m = approve(proposed([clean, overlap]), { by: bob, resolutions: { "/limits/max": 8 }, nowMs: T0 });
    expect(m.approval?.resolutions).toEqual({ "/limits/max": 8 });
  });
  it("refuses a resolution for a path that is not an overlap", () => {
    fail(() => approve(proposed([clean]), { by: bob, resolutions: { "/title": "x" }, nowMs: T0 }), "not_an_overlap");
    fail(() => approve(proposed([clean, overlap]), { by: bob, resolutions: { "/limits/max": 8, "/nope": 1 }, nowMs: T0 }), "not_an_overlap");
  });
  describe("policy changes", () => {
    const needs = { policyRole: "finance" };
    it("need a second approver", () => {
      fail(() => approve(proposed([policy]), { by: alice, resolutions: {}, nowMs: T0, ...needs }), "second_approver_required");
    });
    it("who is a different person with merge on main and the named role", () => {
      fail(() => approve(proposed([policy]), { by: alice, second: alice, resolutions: {}, nowMs: T0, ...needs }), "second_approver_required");
      fail(() => approve(proposed([policy]), { by: alice, second: { ...bob, policyRoles: [] }, resolutions: {}, nowMs: T0, ...needs }), "second_approver_required");
      fail(() => approve(proposed([policy]), { by: alice, second: { ...bob, mainRole: "write" }, resolutions: {}, nowMs: T0, ...needs }), "second_approver_required");
      const m = approve(proposed([policy]), { by: alice, second: bob, resolutions: {}, nowMs: T0, ...needs });
      expect(m.approval).toMatchObject({ by: "alice", second: "bob" });
    });
    it("cannot be satisfied by the agent as second approver", () => {
      fail(() => approve(proposed([policy]), { by: alice, second: { ...bob, principalId: "agent-1" }, resolutions: {}, nowMs: T0, ...needs }), "self_merge");
    });
    it("are refused outright when no policy role is configured", () => {
      fail(() => approve(proposed([policy]), { by: alice, second: bob, resolutions: {}, nowMs: T0 }), "policy_role_unconfigured");
    });
  });
  it("is refused unless the branch is proposed", () => {
    fail(() => approve(forked(), { by: bob, resolutions: {}, nowMs: T0 }), "wrong_state");
  });
  it("is refused after expiry", () => {
    fail(() => approve(proposed(), { by: bob, resolutions: {}, nowMs: T0 + 24 * HOUR }), "expired");
  });
  it("covers the whole latest proposal: an approval names the proposal number it covers", () => {
    const r = returnToAgent(proposed(), { by: bob, comment: "x", nowMs: T0 + 1 });
    const second = propose(r, { by: agent, summary: "v2", changes: [overlap], nowMs: T0 + 2 });
    expect(approve(second, { by: bob, resolutions: { "/limits/max": 1 }, nowMs: T0 + 3 }).approval?.proposal).toBe(2);
  });
});

describe("expiry (tick)", () => {
  it("archives exactly at expiresAt, not a millisecond before", () => {
    expect(tick(forked(), T0 + 24 * HOUR - 1).state).toBe("open");
    expect(tick(forked(), T0 + 24 * HOUR).state).toBe("archived");
    expect(tick(proposed(), T0 + 24 * HOUR).state).toBe("archived");
  });
  it("leaves finished branches alone and is idempotent", () => {
    const merged = approve(proposed(), { by: bob, resolutions: {}, nowMs: T0 });
    expect(tick(merged, T0 + 100 * HOUR).state).toBe("merged");
    const archived = tick(forked(), T0 + 25 * HOUR);
    expect(tick(archived, T0 + 50 * HOUR)).toEqual(archived);
  });
  it("an archived branch cannot be proposed or approved, but is kept", () => {
    const a = tick(proposed(), T0 + 25 * HOUR);
    fail(() => approve(a, { by: bob, resolutions: {}, nowMs: T0 + 25 * HOUR }), "wrong_state");
    expect(a.proposals).toHaveLength(1);
  });
});

describe("kill switch (freeze)", () => {
  it("freezes an open or proposed branch of that agent", () => {
    expect(freeze(forked(), { agentId: "agent-1", nowMs: T0 }).state).toBe("frozen");
    expect(freeze(proposed(), { agentId: "agent-1", nowMs: T0 }).state).toBe("frozen");
  });
  it("leaves another agent's branch and a finished branch alone", () => {
    expect(freeze(forked(), { agentId: "agent-2", nowMs: T0 }).state).toBe("open");
    const merged = approve(proposed(), { by: bob, resolutions: {}, nowMs: T0 });
    expect(freeze(merged, { agentId: "agent-1", nowMs: T0 }).state).toBe("merged");
  });
  it("a frozen branch can neither be proposed nor approved, but can still be rejected", () => {
    const f = freeze(proposed(), { agentId: "agent-1", nowMs: T0 + 5 });
    fail(() => approve(f, { by: bob, resolutions: {}, nowMs: T0 + 6 }), "frozen");
    fail(() => propose(freeze(forked(), { agentId: "agent-1", nowMs: T0 }), { by: agent, summary: "s", changes: [clean], nowMs: T0 }), "frozen");
    expect(reject(f, { by: bob, reason: "key revoked", nowMs: T0 + 7 }).state).toBe("rejected");
  });
});

describe("records are values", () => {
  it("no transition changes its input", () => {
    const b = forked();
    const snapshot = JSON.stringify(b);
    propose(b, { by: agent, summary: "s", changes: [clean], nowMs: T0 });
    tick(b, T0 + 100 * HOUR);
    freeze(b, { agentId: "agent-1", nowMs: T0 });
    expect(JSON.stringify(b)).toBe(snapshot);
  });
});
