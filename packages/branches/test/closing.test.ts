import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { yjsEngine } from "@omnisync/engine";
import {
  BranchError,
  FileBranchStore,
  MemoryBranchStore,
  applyResolutions,
  approve,
  auditForMerge,
  classifyChanges,
  fork,
  planMerge,
  propose,
  type Actor,
  type BranchEntry,
  type BranchRecord,
  type Change,
  type View,
} from "../src/index.js";

// Tests that pin down details the first mutation run showed were unchecked (docs/specs/shadow-branch.md, Tests).
const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const v = (data: View["data"], text = ""): View => ({ text, data });
const alice: Actor = { principalId: "alice", mainRole: "merge", policyRoles: ["finance"] };
const bob: Actor = { principalId: "bob", mainRole: "merge", policyRoles: ["finance"] };
const admin: Actor = { principalId: "root", mainRole: "admin", policyRoles: [] };
const agent: Actor = { principalId: "agent-1", mainRole: "none", policyRoles: [] };
const mk = (over: Partial<Parameters<typeof fork>[0]> = {}): BranchRecord =>
  fork({ id: "b1", mainDocId: "doc", agentId: "agent-1", forkedBy: alice, purpose: "p", base: { mainHeadSeq: 3, mainHeadHash: new Uint8Array([1, 2, 255]), stateVector: new Uint8Array([9]) }, nowMs: T0, ...over });
const prop = (changes: Change[], b = mk(), headSeq?: number) => propose(b, { by: agent, summary: "s", changes, nowMs: T0 + 1, ...(headSeq !== undefined ? { branchHeadSeq: headSeq } : {}) });
const overlapAt = (path: string): Change => ({ path, change: "changed", class: "overlap", policy: false });
const policyAt = (path: string): Change => ({ path, change: "changed", class: "clean", policy: true });
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof BranchError ? e.code : `other:${String(e)}`;
  }
  return undefined;
};
const entries = (...seqs: number[]): BranchEntry[] => seqs.map((seq) => ({ seq, entryHash: new Uint8Array(32).fill(seq), payload: new Uint8Array([seq]) }));

describe("classification details", () => {
  it("text added to an empty document is added, and text emptied is removed", () => {
    const empty = v({});
    expect(classifyChanges({ base: empty, branch: v({}, "x"), main: empty })).toEqual([{ path: "$text", change: "added", class: "clean", policy: false }]);
    expect(classifyChanges({ base: v({}, "x"), branch: empty, main: v({}, "x") })).toEqual([{ path: "$text", change: "removed", class: "clean", policy: false }]);
  });
  it("an empty object is a value of its own: adding one is reported, and so is filling it", () => {
    expect(classifyChanges({ base: v({}), branch: v({ box: {} }), main: v({}) })).toEqual([{ path: "/box", change: "added", class: "clean", policy: false }]);
    expect(classifyChanges({ base: v({ box: {} }), branch: v({ box: { a: 1 } }), main: v({ box: {} }) }).map((c) => [c.path, c.change])).toEqual([
      ["/box", "removed"],
      ["/box/a", "added"],
    ]);
  });
  it("objects inside an array are equal whatever order their keys came in", () => {
    const a = v({ list: [{ a: 1, b: 2 }] });
    const b = v({ list: [{ b: 2, a: 1 }] });
    expect(classifyChanges({ base: a, branch: b, main: a })).toEqual([]);
  });
});

describe("fork details", () => {
  it("an admin can fork and approve, like a merge role", () => {
    expect(mk({ forkedBy: admin }).state).toBe("open");
    expect(approve(prop([overlapAt("/x")], mk({ forkedBy: admin })), { by: admin, resolutions: { "/x": 1 }, nowMs: T0 + 2 }).state).toBe("merged");
  });
  it("the time limit must be positive and at most the maximum, inclusive", () => {
    for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(code(() => mk({ ttlMs }))).toBe("ttl_too_long");
    expect(mk({ ttlMs: 48 * HOUR, maxTtlMs: 48 * HOUR }).expiresAtMs).toBe(T0 + 48 * HOUR);
    expect(code(() => mk({ ttlMs: 48 * HOUR + 1, maxTtlMs: 48 * HOUR }))).toBe("ttl_too_long");
  });
  it("the default maximum is seven days", () => {
    expect(mk({ ttlMs: 7 * 24 * HOUR }).expiresAtMs).toBe(T0 + 7 * 24 * HOUR);
    expect(code(() => mk({ ttlMs: 7 * 24 * HOUR + 1 }))).toBe("ttl_too_long");
  });
});

describe("approval details", () => {
  it("an overlap resolved by removal (value undefined) counts as resolved", () => {
    const m = approve(prop([overlapAt("/limits/min")]), { by: bob, resolutions: { "/limits/min": undefined }, nowMs: T0 + 2 });
    expect(Object.keys(m.approval?.resolutions ?? {})).toEqual(["/limits/min"]);
  });
  it("an empty policy role is no policy role", () => {
    expect(code(() => approve(prop([policyAt("/p")]), { by: alice, second: bob, policyRole: "", resolutions: {}, nowMs: T0 + 2 }))).toBe("policy_role_unconfigured");
  });
  it("the second approver is a different person even when the same person holds every role", () => {
    expect(code(() => approve(prop([policyAt("/p")]), { by: alice, second: alice, policyRole: "finance", resolutions: {}, nowMs: T0 + 2 }))).toBe("second_approver_required");
  });
  it("an agent that is also named as the approver of its own branch is refused in both seats", () => {
    expect(code(() => approve(prop([policyAt("/p")]), { by: alice, second: { ...bob, principalId: "agent-1" }, policyRole: "finance", resolutions: {}, nowMs: T0 + 2 }))).toBe("self_merge");
  });
});

describe("merge plan details", () => {
  const approved = (changes: Change[], resolutions: Record<string, undefined | number>, extra: { second?: Actor; policyRole?: string } = {}, head?: number) =>
    approve(prop(changes, mk(), head), { by: alice, resolutions, nowMs: T0 + 2, ...extra });

  it("is refused for a record that says merged without being a merged branch", () => {
    const m = approved([overlapAt("/x")], { "/x": 1 });
    for (const state of ["open", "rejected", "archived", "frozen"] as const) expect(code(() => planMerge({ ...m, state }, entries(2)))).toBe("wrong_state");
  });
  it("must start right after the seeding update", () => {
    const m = approved([overlapAt("/x")], { "/x": 1 });
    expect(code(() => planMerge(m, entries(3, 4)))).toBe("bad_entries");
    expect(() => planMerge(m, entries(3, 4))).toThrow(/start at seq 2/);
  });
  it("names a repeated entry as a repeat and a missing one as a gap", () => {
    const m = approved([overlapAt("/x")], { "/x": 1 });
    expect(() => planMerge(m, [...entries(2), ...entries(2), ...entries(3)])).toThrow(/repeat of seq 2/);
    expect(() => planMerge(m, entries(2, 4))).toThrow(/gap between seq 2 and 4/);
  });
  it("lists resolutions in path order whatever order they were made in", () => {
    const m = approved([overlapAt("/b"), overlapAt("/a"), overlapAt("/c")], { "/c": 3, "/a": 1, "/b": 2 });
    const plan = planMerge(m, entries(2));
    expect(plan.resolutions.map((r) => r.path)).toEqual(["/a", "/b", "/c"]);
    expect(plan.record.resolvedPaths).toEqual(["/a", "/b", "/c"]);
  });
  it("records the second approver and the policy role, and the audit entry carries them", () => {
    const m = approved([policyAt("/p")], {}, { second: bob, policyRole: "finance" });
    const plan = planMerge(m, entries(2));
    expect(plan.record).toMatchObject({ approvedBy: "alice", secondApprover: "bob", policyRole: "finance" });
    expect(JSON.parse(auditForMerge(plan.record).detail)).toMatchObject({ secondApprover: "bob", policyRole: "finance" });
  });
  it("does not change the entries it is given", () => {
    const m = approved([overlapAt("/x")], { "/x": 1 }, {}, 3);
    const given = entries(4, 3, 2);
    planMerge(m, given);
    expect(given.map((e) => e.seq)).toEqual([4, 3, 2]);
  });
});

describe("resolution details", () => {
  it("the text can only be replaced by a string", () => {
    const d = yjsEngine.create(1);
    d.insertText(0, "old");
    expect(code(() => applyResolutions(d, [{ path: "$text", value: 5 }]))).toBe("bad_path");
    expect(code(() => applyResolutions(d, [{ path: "$text", value: undefined }]))).toBe("bad_path");
    expect(d.getText()).toBe("old");
  });
  it("replacing the text with nothing is one deletion and no empty insertion", () => {
    const d = yjsEngine.create(1);
    d.insertText(0, "old");
    expect(applyResolutions(d, [{ path: "$text", value: "" }])).toHaveLength(1);
    expect(d.getText()).toBe("");
    expect(applyResolutions(yjsEngine.create(2), [{ path: "$text", value: "" }])).toHaveLength(0);
  });
  it("a path must be a pointer with a key: not the root, and not a bare word", () => {
    const d = yjsEngine.create(1);
    d.mapSet([], "limits", 1);
    expect(code(() => applyResolutions(d, [{ path: "/", value: 1 }]))).toBe("bad_path");
    expect(code(() => applyResolutions(d, [{ path: "limits", value: 2 }]))).toBe("bad_path");
    expect(d.getData()).toEqual({ limits: 1 });
  });
  it("unescapes ~1 and ~0 in the right order: ~01 is the key ~1, not a slash", () => {
    const d = yjsEngine.create(1);
    d.mapSet([], "a~1", 1);
    applyResolutions(d, [{ path: "/a~01", value: 2 }]);
    expect(d.getData()).toEqual({ "a~1": 2 });
  });
  it("removal really removes: the key is gone, not set to something", () => {
    const d = yjsEngine.create(1);
    d.mapSet([], "k", 1);
    applyResolutions(d, [{ path: "/k", value: undefined }]);
    expect("k" in d.getData()).toBe(false);
  });
});

describe("store details", () => {
  it("memory store: what was saved and what was listed are copies", async () => {
    const store = new MemoryBranchStore();
    const rec = mk();
    await store.save(rec);
    rec.base.mainHeadHash[0] = 77; // the caller changes its own object after saving
    expect(Array.from((await store.get("doc~b~b1"))?.base.mainHeadHash ?? [])).toEqual([1, 2, 255]);
    const listed = await store.list();
    listed[0]!.base.mainHeadHash[0] = 88;
    expect(Array.from((await store.get("doc~b~b1"))?.base.mainHeadHash ?? [])).toEqual([1, 2, 255]);
  });
  it("lists records created at the same moment in a fixed order (by document id)", async () => {
    const store = new MemoryBranchStore();
    await store.save(mk({ id: "b" }));
    await store.save(mk({ id: "a" }));
    await store.save(mk({ id: "c" }));
    expect((await store.list()).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
  it("file store: ignores files that are not records, and writes owner-only files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "branches-"));
    try {
      const store = new FileBranchStore(dir);
      await store.save(mk());
      await writeFile(join(dir, "leftover.tmp"), "not json");
      expect((await store.list()).map((r) => r.id)).toEqual(["b1"]);
      const name = (await readdir(dir)).find((n) => n.endsWith(".json")) as string;
      expect((await stat(join(dir, name))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
