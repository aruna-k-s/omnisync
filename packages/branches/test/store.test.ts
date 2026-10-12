import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BranchError,
  FileBranchStore,
  MemoryBranchStore,
  approve,
  auditForMerge,
  auditForTransition,
  fork,
  planMerge,
  propose,
  type Actor,
  type BranchRecord,
  type BranchStore,
  type Change,
} from "../src/index.js";

const T0 = 1_800_000_000_000;
const alice: Actor = { principalId: "alice", mainRole: "merge", policyRoles: [] };
const agent: Actor = { principalId: "agent-1", mainRole: "none", policyRoles: [] };
const change: Change = { path: "/secret/name", change: "changed", class: "clean", policy: false };

const make = (id = "b1", mainDocId = "doc", nowMs = T0): BranchRecord =>
  fork({ id, mainDocId, agentId: "agent-1", forkedBy: alice, purpose: "p", base: { mainHeadSeq: 3, mainHeadHash: new Uint8Array([1, 2, 255]), stateVector: new Uint8Array([9, 0, 7]) }, nowMs });

describe.each(["memory", "file"] as const)("%s branch store", (kind) => {
  let dir: string;
  let store: BranchStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "branches-"));
    store = kind === "memory" ? new MemoryBranchStore() : new FileBranchStore(join(dir, "nested", "branches"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns nothing for an unknown branch and an empty list for an empty store", async () => {
    expect(await store.get("doc~b~nope")).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it("round-trips a record exactly, bytes included", async () => {
    const b = propose(make(), { by: agent, summary: "s", changes: [change], nowMs: T0 + 1 });
    await store.save(make());
    await store.save(b);
    const back = await store.get("doc~b~b1");
    expect(back).toEqual(b);
    expect(back?.base.mainHeadHash).toBeInstanceOf(Uint8Array);
    expect(Array.from(back?.base.mainHeadHash ?? [])).toEqual([1, 2, 255]);
  });

  it("returns copies: changing what was read does not change what is stored", async () => {
    await store.save(make());
    const r = (await store.get("doc~b~b1")) as BranchRecord;
    r.base.mainHeadHash[0] = 99;
    expect(Array.from((await store.get("doc~b~b1"))?.base.mainHeadHash ?? [])).toEqual([1, 2, 255]);
  });

  it("accepts a save only on top of the version the writer read", async () => {
    const v1 = make();
    await store.save(v1);
    await expect(store.save(v1)).rejects.toMatchObject({ code: "conflict" }); // saving the same version again
    const v2 = propose(v1, { by: agent, summary: "s", changes: [change], nowMs: T0 + 1 });
    await store.save(v2);
    const stale = propose(v1, { by: agent, summary: "other", changes: [change], nowMs: T0 + 2 }); // built on v1, after v2 was saved
    await expect(store.save(stale)).rejects.toBeInstanceOf(BranchError);
    expect((await store.get("doc~b~b1"))?.proposals[0]?.summary).toBe("s");
  });

  it("refuses a first save that is not a fresh fork", async () => {
    const b = propose(make(), { by: agent, summary: "s", changes: [change], nowMs: T0 + 1 });
    await expect(store.save(b)).rejects.toMatchObject({ code: "conflict" });
  });

  it("lists by main document, agent and state, oldest first", async () => {
    await store.save(make("a", "doc1", T0 + 5));
    await store.save(make("b", "doc1", T0));
    await store.save(make("c", "doc2", T0 + 1));
    await store.save(make("d", "doc2", T0 + 2));
    expect((await store.list()).map((r) => r.id)).toEqual(["b", "c", "d", "a"]);
    expect((await store.list({ mainDocId: "doc1" })).map((r) => r.id)).toEqual(["b", "a"]);
    expect((await store.list({ agentId: "nobody" })).map((r) => r.id)).toEqual([]);
    expect((await store.list({ state: "open", mainDocId: "doc2" })).map((r) => r.id)).toEqual(["c", "d"]);
    expect((await store.list({ state: "merged" })).map((r) => r.id)).toEqual([]);
  });

  it("keeps two main documents' branches with the same id apart", async () => {
    await store.save(make("same", "doc1"));
    await store.save(make("same", "doc2"));
    expect((await store.get("doc1~b~same"))?.mainDocId).toBe("doc1");
    expect((await store.get("doc2~b~same"))?.mainDocId).toBe("doc2");
  });
});

describe("file branch store", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "branches-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("never uses the document id as a path, and leaves no temporary file", async () => {
    const store = new FileBranchStore(join(dir, "b"));
    const evil = make("x", "../../etc/passwd");
    await store.save(evil);
    expect((await store.get(evil.branchDocId))?.mainDocId).toBe("../../etc/passwd");
    const names = await readdir(join(dir, "b"));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[A-Za-z0-9_-]+\.json$/);
  });

  it("survives a new store object over the same directory", async () => {
    await new FileBranchStore(join(dir, "b")).save(make());
    expect((await new FileBranchStore(join(dir, "b")).get("doc~b~b1"))?.id).toBe("b1");
  });
});

describe("audit entries", () => {
  it("name the transition, the actor and the branch document, and carry ids and counts only", () => {
    const b = propose(make(), { by: agent, summary: "mentions the word Confidential", changes: [change], nowMs: T0 + 1 });
    const a = auditForTransition(b);
    expect(a).toMatchObject({ atMs: T0 + 1, actor: "agent-1", action: "branch.propose", target: "doc~b~b1" });
    expect(JSON.parse(a.detail)).toEqual({ branch: "b1", main: "doc", agent: "agent-1", state: "proposed", proposal: 1, changes: 1 });
    expect(a.detail).not.toMatch(/secret|Confidential/); // neither a path nor the summary leaves the branch record
  });

  it("a fork is attributed to the person who forked", () => {
    expect(auditForTransition(make())).toMatchObject({ actor: "alice", action: "branch.fork" });
  });

  it("the merge entry links main to the agent's ledger: seqs, count, head hash, approvers", () => {
    const merged = approve(propose(make(), { by: agent, summary: "s", changes: [change], branchHeadSeq: 3, nowMs: T0 + 1 }), { by: alice, resolutions: {}, nowMs: T0 + 2 });
    const entries = [2, 3].map((seq) => ({ seq, entryHash: new Uint8Array(32).fill(seq), payload: new Uint8Array([seq]) }));
    const a = auditForMerge(planMerge(merged, entries).record);
    expect(a).toMatchObject({ atMs: T0 + 2, actor: "alice", action: "branch.merge", target: "doc" });
    expect(JSON.parse(a.detail)).toEqual({
      branch: "doc~b~b1",
      agent: "agent-1",
      proposal: 1,
      stepUp: "none",
      baseMainHeadSeq: 3,
      branchSeqs: [2, 3],
      entries: 2,
      headEntryHash: "03".repeat(32),
      resolutions: 0,
    });
  });
});
