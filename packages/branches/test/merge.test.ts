import { describe, expect, it } from "vitest";
import { yjsEngine, type EngineDoc } from "@omnisync/engine";
import {
  BranchError,
  applyResolutions,
  approve,
  classifyChanges,
  fork,
  planMerge,
  propose,
  reject,
  type Actor,
  type BranchEntry,
  type BranchRecord,
} from "../src/index.js";

const T0 = 1_800_000_000_000;
const alice: Actor = { principalId: "alice", mainRole: "merge", policyRoles: [] };
const agentActor: Actor = { principalId: "agent-1", mainRole: "none", policyRoles: [] };

const view = (d: EngineDoc) => ({ text: d.getText(), data: d.getData() });
const hash = (n: number) => new Uint8Array(32).fill(n);

/** A main document, a branch forked from it at its current state, an agent that edits the branch, and a human who edits main meanwhile. */
function scenario() {
  const main = yjsEngine.create(1);
  main.mapSet([], "title", "Q3");
  main.mapSet([], "limits", { max: 5, min: 1 });
  main.insertText(0, "Intro. ");
  const baseState = main.snapshot();
  const base = yjsEngine.load(baseState, 9);

  const branch = yjsEngine.load(baseState, 2);
  const entries: BranchEntry[] = [];
  const agentEdit = (update: Uint8Array) => entries.push({ seq: entries.length + 2, entryHash: hash(entries.length + 2), payload: update }); // seq 1 is the human's seeding update
  agentEdit(branch.mapSet([], "title", "Q3 plan"));
  agentEdit(branch.mapSet(["limits"], "max", 8));
  agentEdit(branch.insertText(branch.getText().length, "Section 3 draft."));
  return { main, base, branch, entries };
}

function proposal(main: EngineDoc, base: EngineDoc, branch: EngineDoc, reviewRequired: string[] = []): BranchRecord {
  const rec = fork({
    id: "b1",
    mainDocId: "doc",
    agentId: "agent-1",
    forkedBy: alice,
    purpose: "p",
    base: { mainHeadSeq: 10, mainHeadHash: hash(7), stateVector: base.encodeStateVector() },
    nowMs: T0,
  });
  return propose(rec, { by: agentActor, summary: "s", changes: classifyChanges({ base: view(base), branch: view(branch), main: view(main), reviewRequired }), nowMs: T0 + 1 });
}

const copyOf = (d: EngineDoc, actor: number) => yjsEngine.load(d.snapshot(), actor);

describe("planMerge from real documents", () => {
  it("applying the plan's updates to main gives main plus the agent's changes", () => {
    const { main, base, branch, entries } = scenario();
    const merged = approve(proposal(main, base, branch), { by: alice, resolutions: {}, nowMs: T0 + 2 });
    const plan = planMerge(merged, entries);
    const target = copyOf(main, 3);
    for (const u of plan.updates) target.applyUpdate(u);
    expect(target.getData()).toEqual(branch.getData());
    expect(target.getText()).toBe(branch.getText());
  });

  it("keeps what main gained meanwhile when the changes do not overlap", () => {
    const { main, base, branch, entries } = scenario();
    main.mapSet([], "owner", "ana"); // a human edits a different field after the fork
    const merged = approve(proposal(main, base, branch), { by: alice, resolutions: {}, nowMs: T0 + 2 });
    const target = copyOf(main, 3);
    for (const u of planMerge(merged, entries).updates) target.applyUpdate(u);
    expect(target.getData()).toMatchObject({ owner: "ana", title: "Q3 plan", limits: { max: 8, min: 1 } });
  });

  it("an overlap takes the reviewer's value, applied after the agent's updates", () => {
    const { main, base, branch, entries } = scenario();
    main.mapSet(["limits"], "max", 6); // main changed the same field the agent changed
    const rec = proposal(main, base, branch);
    expect(rec.proposals[0]?.changes.find((c) => c.path === "/limits/max")?.class).toBe("overlap");
    const merged = approve(rec, { by: alice, resolutions: { "/limits/max": 7 }, nowMs: T0 + 2 });
    const plan = planMerge(merged, entries);
    expect(plan.resolutions).toEqual([{ path: "/limits/max", value: 7 }]);
    const target = copyOf(main, 3);
    for (const u of plan.updates) target.applyUpdate(u);
    const updates = applyResolutions(target, plan.resolutions);
    expect(updates).toHaveLength(1); // the human's resolution is its own edit, to be signed by the human
    expect(target.getData()).toMatchObject({ limits: { max: 7, min: 1 } });
  });

  it("the text can be resolved too", () => {
    const { main, base, branch, entries } = scenario();
    main.insertText(0, "Main edit. ");
    const rec = proposal(main, base, branch);
    expect(rec.proposals[0]?.changes.find((c) => c.path === "$text")?.class).toBe("overlap");
    const merged = approve(rec, { by: alice, resolutions: { $text: "Chosen text." }, nowMs: T0 + 2 });
    const target = copyOf(main, 3);
    const plan = planMerge(merged, entries);
    for (const u of plan.updates) target.applyUpdate(u);
    applyResolutions(target, plan.resolutions);
    expect(target.getText()).toBe("Chosen text.");
  });

  it("updates are the agent's payloads, byte for byte, in branch order, and the plan is deterministic", () => {
    const { main, base, branch, entries } = scenario();
    const merged = approve(proposal(main, base, branch), { by: alice, resolutions: {}, nowMs: T0 + 2 });
    const plan = planMerge(merged, [...entries].reverse()); // order given does not matter: seq decides
    expect(plan.updates).toEqual(entries.map((e) => e.payload));
    expect(planMerge(merged, entries)).toEqual(plan);
  });

  it("the merge record cites the proposal, the branch, the entries, the approvers and the base", () => {
    const { main, base, branch, entries } = scenario();
    const merged = approve(proposal(main, base, branch), { by: alice, resolutions: {}, nowMs: T0 + 2 });
    const r = planMerge(merged, entries).record;
    expect(r).toMatchObject({
      branchId: "b1",
      branchDocId: "doc~b~b1",
      mainDocId: "doc",
      proposal: 1,
      approvedBy: "alice",
      stepUp: "none",
      baseMainHeadSeq: 10,
      fromSeq: 2,
      toSeq: 4,
      entryCount: 3,
    });
    expect(r.headEntryHash).toEqual(entries[2]?.entryHash);
    expect(r.entryHashes).toEqual(entries.map((e) => e.entryHash));
    expect(r.secondApprover).toBeUndefined();
  });

  it("refuses a branch that is not merged (open, proposed, rejected)", () => {
    const { main, base, branch, entries } = scenario();
    const p = proposal(main, base, branch);
    for (const rec of [p, reject(p, { by: alice, reason: "no", nowMs: T0 + 2 })]) {
      expect(() => planMerge(rec, entries)).toThrow(BranchError);
    }
  });

  it("refuses entries that do not form the branch's tail after the seeding update: a gap, a repeat, or none", () => {
    const { main, base, branch, entries } = scenario();
    const merged = approve(proposal(main, base, branch), { by: alice, resolutions: {}, nowMs: T0 + 2 });
    expect(() => planMerge(merged, [])).toThrow(/entries/);
    expect(() => planMerge(merged, [entries[0]!, entries[2]!])).toThrow(/gap/);
    expect(() => planMerge(merged, [entries[0]!, entries[0]!, entries[1]!])).toThrow(/repeat|gap/);
    expect(() => planMerge(merged, [{ ...entries[0]!, seq: 1 }, ...entries.slice(1)])).toThrow(/seeding|seq/);
  });
});

describe("applyResolutions", () => {
  it("sets a nested value, removes a key when the value is undefined (the reviewer chose removal), and replaces the text", () => {
    const d = yjsEngine.create(1);
    d.mapSet([], "limits", { max: 5, min: 1 });
    d.insertText(0, "old");
    applyResolutions(d, [
      { path: "/limits/max", value: 9 },
      { path: "/limits/min", value: undefined },
      { path: "$text", value: "new" },
    ]);
    expect(d.getData()).toEqual({ limits: { max: 9 } });
    expect(d.getText()).toBe("new");
  });
  it("unescapes JSON pointer keys", () => {
    const d = yjsEngine.create(1);
    d.mapSet([], "a/b", 1);
    applyResolutions(d, [{ path: "/a~1b", value: 2 }]);
    expect(d.getData()).toEqual({ "a/b": 2 });
  });
  it("refuses a path through something that is not a map", () => {
    const d = yjsEngine.create(1);
    d.mapSet([], "tags", ["a"]);
    let err: unknown;
    try {
      applyResolutions(d, [{ path: "/tags/x", value: 1 }]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BranchError);
    expect((err as BranchError).code).toBe("bad_path");
  });
});
