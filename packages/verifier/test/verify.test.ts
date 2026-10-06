import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ledgerSignerFromKeyPair } from "@omnisync/crypto";
import { signUpdate } from "@omnisync/protocol";
import { verifyLedger, type Report, type ViolationCode } from "../src/index.js";
import { Fixture, HOUR, T0, issuer, ledger, parse, stranger, trust } from "./fixture.js";

const codes = (r: Report): ViolationCode[] => [...new Set(r.violations.map((v) => v.code))].sort();

async function healthy(): Promise<Fixture> {
  const f = new Fixture();
  const a = f.addUser(1);
  const b = f.addUser(2);
  f.append("doc-a", a);
  f.append("doc-a", b);
  f.append("doc-b", a);
  f.append("doc-a", a);
  await f.checkpoint();
  return f;
}

const run = (lines: readonly string[], opts = {}) => verifyLedger(parse(lines), trust, opts);

describe("verifier: a healthy ledger", () => {
  it("verifies, counts everything and reports no unattested tail", async () => {
    const f = await healthy();
    const r = await run(f.lines());
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.counts).toEqual({ documents: 2, entries: 4, certificates: 2, checkpoints: 1, erased: 0, entriesAfterLastCheckpoint: 0 });
    expect(r.tenant).toBe("acme");
  });

  it("counts entries newer than the last checkpoint as unattested, and still passes", async () => {
    const f = await healthy();
    f.append("doc-a", f.users[0]!);
    f.append("doc-c", f.users[1]!);
    const r = await run(f.lines());
    expect(r.ok).toBe(true);
    expect(r.counts.entriesAfterLastCheckpoint).toBe(2);
  });

  it("an export with entries but no checkpoints passes the chain checks and warns", async () => {
    const f = new Fixture();
    f.append("d", f.addUser(1));
    const r = await run(f.lines());
    expect(r.ok).toBe(true);
    expect(r.warnings.join()).toMatch(/no checkpoints/);
    expect(r.counts.entriesAfterLastCheckpoint).toBe(1);
  });

  it("accepts an erased payload: hashes are checked, the frame is not needed", async () => {
    const f = await healthy();
    const lines = parse(f.lines()) as Record<string, unknown>[];
    for (const l of lines) if (l.t === "entry" && l.doc === "doc-b") delete l.frame;
    const r = await verifyLedger(lines, trust);
    expect(r.ok).toBe(true);
    expect(r.counts.erased).toBe(1);
  });

  it("works on a streamed async iterable", async () => {
    const f = await healthy();
    async function* gen() {
      for (const l of f.lines()) yield JSON.parse(l) as unknown;
    }
    expect((await verifyLedger(gen(), trust)).ok).toBe(true);
  });

  it("accepts an upload-only edit: expired certificate, edit claimed before expiry, received inside grace", async () => {
    const f = new Fixture();
    const u = f.addUser(1, { notAfterMs: T0 + 2 * HOUR });
    f.append("d", u, { claimedAtMs: T0 + 2 * HOUR - 1000, receivedAtMs: T0 + 40 * HOUR });
    await f.checkpoint();
    expect((await run(f.lines())).violations).toEqual([]);
  });
});

describe("verifier: tamper detection", () => {
  const mutateLine = (lines: string[], i: number, fn: (o: Record<string, unknown>) => void): string[] => {
    const copy = [...lines];
    const o = JSON.parse(copy[i] as string) as Record<string, unknown>;
    fn(o);
    copy[i] = JSON.stringify(o);
    return copy;
  };
  const indexOf = (lines: string[], pred: (o: Record<string, unknown>) => boolean): number =>
    lines.findIndex((l) => pred(JSON.parse(l) as Record<string, unknown>));

  it("a changed receive time is caught", async () => {
    const f = await healthy();
    const lines = f.lines();
    const i = indexOf(lines, (o) => o.t === "entry" && o.doc === "doc-a" && o.seq === 2);
    const r = await run(mutateLine(lines, i, (o) => (o.receivedAtMs = (o.receivedAtMs as number) + 1)));
    expect(codes(r)).toContain("entry_hash_mismatch");
    expect(r.ok).toBe(false);
  });

  it("an edited frame is caught by its hash, and a re-hashed one by the entry hash", async () => {
    const f = await healthy();
    const lines = f.lines();
    const i = indexOf(lines, (o) => o.t === "entry" && o.doc === "doc-a" && o.seq === 1);
    const forged = Buffer.from(signUpdate({ docId: "doc-a", sessionId: 1, seq: 99, claimedAtMs: T0 + 1000, payload: new Uint8Array([1]) }, stranger)).toString("base64");
    const r = await run(mutateLine(lines, i, (o) => (o.frame = forged)));
    expect(codes(r)).toEqual(expect.arrayContaining(["frame_hash_mismatch"]));
  });

  it("a rewritten history with a consistent chain is caught by the checkpoint", async () => {
    const f = await healthy();
    // The attacker rewrites doc-a from entry 2 on, recomputing every hash, but cannot re-sign the checkpoint.
    const evil = new Fixture();
    for (const u of f.users) evil.users.push(u);
    evil.append("doc-a", f.users[0]!);
    evil.append("doc-a", f.users[0]!, { payload: new Uint8Array([66]) }); // different from the original entry 2
    evil.append("doc-a", f.users[1]!);
    evil.append("doc-a", f.users[0]!);
    evil.append("doc-b", f.users[0]!);
    evil.checkpoints.push(...f.checkpoints);
    const r = await run(evil.lines());
    expect(codes(r)).toContain("checkpoint_head_mismatch");
  });

  it("swapping an entry's certificate for another user's is caught", async () => {
    const f = await healthy();
    const lines = f.lines();
    const i = indexOf(lines, (o) => o.t === "entry" && o.doc === "doc-a" && o.seq === 1);
    const other = Buffer.from(f.users[1]!.serial).toString("hex");
    const r = await run(mutateLine(lines, i, (o) => (o.certSerial = other)));
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("entry_hash_mismatch");
  });

  it("swapping the certificate AND recomputing hashes is still caught: the signature belongs to another key", async () => {
    const f = new Fixture();
    const a = f.addUser(1);
    const b = f.addUser(2);
    f.append("d", a);
    const e = f.entries[0]!;
    // Re-chain the entry under b's serial; the frame is still signed by a's key.
    const g = new Fixture();
    g.users.push(a, b);
    const forged = g.append("d", b);
    const lines = f.lines().map((l) => l);
    const i = indexOf(lines, (o) => o.t === "entry");
    const r = await run(
      mutateLine(lines, i, (o) => {
        o.certSerial = Buffer.from(b.serial).toString("hex");
        o.entryHash = Buffer.from(forged.entryHash).toString("hex");
        o.prevHash = Buffer.from(forged.prevHash).toString("hex");
        o.frameHash = Buffer.from(e.frameHash).toString("hex");
        o.payloadHash = Buffer.from(e.payloadHash).toString("hex");
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("a deleted middle entry is a gap", async () => {
    const f = await healthy();
    const lines = f.lines();
    const i = indexOf(lines, (o) => o.t === "entry" && o.doc === "doc-a" && o.seq === 2);
    lines.splice(i, 1);
    const r = await run(lines);
    expect(codes(r)).toEqual(expect.arrayContaining(["chain_gap", "chain_break"]));
  });

  it("a deleted last entry that a checkpoint attests is truncation", async () => {
    const f = await healthy();
    const lines = f.lines();
    const i = indexOf(lines, (o) => o.t === "entry" && o.doc === "doc-a" && o.seq === 3);
    lines.splice(i, 1);
    const r = await run(lines);
    expect(codes(r)).toContain("truncated");
  });

  it("a deleted document is truncation", async () => {
    const f = await healthy();
    const lines = f.lines().filter((l) => !(JSON.parse(l) as { doc?: string }).doc?.endsWith("b"));
    expect(codes(await run(lines))).toContain("truncated");
  });

  it("reordered entries are caught", async () => {
    const f = await healthy();
    const lines = f.lines();
    const i = indexOf(lines, (o) => o.t === "entry" && o.doc === "doc-a" && o.seq === 1);
    [lines[i], lines[i + 1]] = [lines[i + 1] as string, lines[i] as string];
    expect(codes(await run(lines))).toContain("chain_gap");
  });

  it("a duplicated entry is caught", async () => {
    const f = await healthy();
    const lines = f.lines();
    const i = indexOf(lines, (o) => o.t === "entry" && o.doc === "doc-a" && o.seq === 2);
    lines.splice(i, 0, lines[i] as string);
    expect(codes(await run(lines))).toContain("chain_gap");
  });

  it("a checkpoint signed by the wrong key is rejected, including the certificate issuing key", async () => {
    for (const key of [stranger, issuer]) {
      const f = new Fixture();
      f.append("d", f.addUser(1));
      await f.checkpoint(ledgerSignerFromKeyPair(key));
      const r = await run(f.lines());
      expect(codes(r)).toContain("checkpoint_signature");
    }
  });

  it("a dropped checkpoint breaks the checkpoint chain", async () => {
    const f = await healthy();
    f.append("doc-a", f.users[0]!);
    await f.checkpoint();
    f.append("doc-a", f.users[0]!);
    await f.checkpoint();
    const lines = f.lines();
    const i = indexOf(lines, (o) => o.t === "checkpoint");
    lines.splice(i + 1, 1); // drop the second of three
    const r = await run(lines);
    expect(codes(r)).toEqual(expect.arrayContaining(["checkpoint_gap", "checkpoint_chain"]));
  });

  it("a certificate from an untrusted issuer or with a changed byte is caught", async () => {
    const f = new Fixture();
    f.append("d", f.addUser(1, { issuerKey: stranger }));
    await f.checkpoint();
    expect(codes(await run(f.lines()))).toContain("cert_untrusted");

    const g = await healthy();
    const lines = g.lines();
    const i = indexOf(lines, (o) => o.t === "cert");
    const r = await run(
      mutateLine(lines, i, (o) => {
        const b = Buffer.from(o.certificate as string, "base64");
        b[20] = (b[20] as number) ^ 1;
        o.certificate = b.toString("base64");
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("an entry whose certificate is missing from the export is caught", async () => {
    const f = await healthy();
    const lines = f.lines().filter((l) => (JSON.parse(l) as { t: string }).t !== "cert");
    expect(codes(await run(lines))).toContain("cert_missing");
  });

  it("an update signed for another document is caught", async () => {
    const f = await healthy();
    const lines = f.lines();
    const i = indexOf(lines, (o) => o.t === "entry" && o.doc === "doc-b");
    const moved = mutateLine(lines, i, (o) => (o.doc = "doc-z"));
    const r = await run(moved);
    expect(r.ok).toBe(false);
  });

  it("received outside the certificate window, or claimed outside it or in the future, is caught", async () => {
    const f = new Fixture();
    const u = f.addUser(1, { notAfterMs: T0 + 2 * HOUR });
    f.append("d", u, { receivedAtMs: T0 + 100 * HOUR, claimedAtMs: T0 + HOUR }); // far beyond the 72 h grace
    f.append("d", u, { receivedAtMs: T0 + HOUR, claimedAtMs: T0 + 3 * HOUR }); // claimed after expiry
    f.append("d", u, { receivedAtMs: T0 + HOUR, claimedAtMs: T0 + 2 * HOUR }); // claimed ahead of receipt (beyond skew)
    f.append("d", u, { receivedAtMs: T0 - HOUR, claimedAtMs: T0 - HOUR }); // before validity
    await f.checkpoint();
    expect(codes(await run(f.lines()))).toEqual(expect.arrayContaining(["cert_window", "claimed_window", "claimed_in_future"]));
  });

  it("an entry with no certificate is caught", async () => {
    const f = await healthy();
    const lines = f.lines();
    const i = indexOf(lines, (o) => o.t === "entry");
    const r = await run(mutateLine(lines, i, (o) => delete o.certSerial));
    expect(codes(r)).toContain("cert_missing");
  });

  it("export structure is enforced: order, version, malformed records", async () => {
    const f = await healthy();
    const lines = f.lines();
    expect(codes(await run(lines.slice(1)))).toContain("export_order"); // no meta
    expect(codes(await run([...lines, lines[2] as string]))).toContain("export_order"); // cert after entries
    expect(codes(await run([lines[0]!.replace('"version":1', '"version":9'), ...lines.slice(1)]))).toContain("export_version");
    expect(codes(await run([...lines, "{}", '{"t":"entry"}']))).toContain("export_malformed");
    expect(codes(await run([...lines, lines.at(-1) as string]))).toEqual(expect.arrayContaining(["chain_gap"]));
    const interleaved = [...lines];
    interleaved.push(interleaved[interleaved.length - 5] as string); // a doc-a entry after doc-b's
    expect((await run(interleaved)).ok).toBe(false);
    expect(codes(await run([]))).toContain("export_order");
    expect(await verifyLedger([null, 5, "x", []], trust)).toMatchObject({ ok: false });
  });

  it("a checkpoint for a different tenant is caught", async () => {
    const f = await healthy();
    const lines = f.lines();
    lines[0] = lines[0]!.replace('"acme"', '"other"');
    expect(codes(await run(lines))).toContain("checkpoint_tenant");
  });

  it("caps stored violations but still counts all of them", async () => {
    const f = await healthy();
    const noCerts = f.lines().filter((l) => (JSON.parse(l) as { t: string }).t !== "cert");
    const r = await verifyLedger(parse(noCerts), trust, { maxViolations: 2 });
    expect(r.violations.length).toBe(2);
    expect(r.violationsTotal).toBe(4); // one per entry
  });
});

describe("verifier: locked checkpoints", () => {
  it("passes when the locked copies match and tolerates newer exported checkpoints", async () => {
    const f = await healthy();
    const locked = new Map([[1, f.checkpoints[0] as Uint8Array]]);
    expect((await run(f.lines(), { locked })).ok).toBe(true);
    f.append("doc-a", f.users[0]!);
    await f.checkpoint();
    const r = await run(f.lines(), { locked });
    expect(r.ok).toBe(true);
    expect(r.warnings.join()).toMatch(/newer than the newest locked/);
  });

  it("catches a whole-database rewrite: a consistent export with different checkpoints", async () => {
    const real = await healthy();
    const locked = new Map([[1, real.checkpoints[0] as Uint8Array]]);
    // The attacker owns the database and even a ledger key copy, and rebuilds everything consistently.
    const fake = new Fixture();
    fake.users.push(...real.users);
    fake.append("doc-a", real.users[0]!, { payload: new Uint8Array([9]) });
    await fake.checkpoint();
    const r = await run(fake.lines(), { locked });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("locked_mismatch");
  });

  it("catches a database whose newest checkpoints were deleted", async () => {
    const f = await healthy();
    f.append("doc-a", f.users[0]!);
    await f.checkpoint();
    const locked = new Map([
      [1, f.checkpoints[0] as Uint8Array],
      [2, f.checkpoints[1] as Uint8Array],
    ]);
    const cut = f.lines().filter((l) => {
      const o = JSON.parse(l) as { t: string; bytes?: string };
      return !(o.t === "checkpoint" && o.bytes === Buffer.from(f.checkpoints[1] as Uint8Array).toString("base64"));
    });
    // Also drop the entry the second checkpoint covered so the export is internally consistent.
    const parsed = cut.map((l) => JSON.parse(l) as { t: string; doc?: string; seq?: number });
    const lastDocA = parsed.map((o) => o.t === "entry" && o.doc === "doc-a").lastIndexOf(true);
    cut.splice(lastDocA, 1);
    const r = await run(cut, { locked });
    expect(codes(r)).toContain("locked_missing");
  });

  it("catches a checkpoint inserted that the locked store never had", async () => {
    const f = new Fixture();
    f.append("d", f.addUser(1));
    await f.checkpoint();
    f.append("d", f.users[0]!);
    await f.checkpoint();
    f.append("d", f.users[0]!);
    await f.checkpoint();
    const locked = new Map([
      [1, f.checkpoints[0] as Uint8Array],
      [3, f.checkpoints[2] as Uint8Array],
    ]);
    expect(codes(await run(f.lines(), { locked }))).toContain("locked_extra");
  });
});

describe("verifier: properties", () => {
  const scenario = fc.record({
    users: fc.integer({ min: 1, max: 3 }),
    ops: fc.array(fc.record({ doc: fc.constantFrom("a", "b", "c"), user: fc.nat(2), checkpoint: fc.boolean() }), { minLength: 3, maxLength: 14 }),
  });

  async function build(s: { users: number; ops: { doc: string; user: number; checkpoint: boolean }[] }): Promise<Fixture> {
    const f = new Fixture();
    for (let i = 1; i <= s.users; i++) f.addUser(i);
    // Every user signs at least once so no certificate in the export is unused.
    s.ops.slice(0, 0);
    f.users.forEach((u, i) => f.append(`d${"abc"[i % 3]}`, u));
    for (const op of s.ops) {
      f.append(`d${op.doc}`, f.users[op.user % f.users.length] as (typeof f.users)[number]);
      if (op.checkpoint) await f.checkpoint();
    }
    await f.checkpoint(); // the final checkpoint covers everything, so there is no unattested tail
    return f;
  }

  it("any valid ledger verifies", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        const f = await build(s);
        const r = await run(f.lines());
        return r.ok && r.counts.entriesAfterLastCheckpoint === 0;
      }),
      { numRuns: 60 },
    );
  });

  it("changing any single field of any non-meta record is detected", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, fc.nat(), fc.nat(), fc.integer({ min: 1, max: 255 }), async (s, pickRecord, pickField, x) => {
        const f = await build(s);
        const lines = parse(f.lines()) as Record<string, unknown>[];
        const candidates = lines.map((o, i) => [o, i] as const).filter(([o]) => o.t !== "meta");
        const [rec] = candidates[pickRecord % candidates.length] as readonly [Record<string, unknown>, number];
        const fields = Object.keys(rec).filter((k) => k !== "t");
        const field = fields[pickField % fields.length] as string;
        const v = rec[field];
        if (typeof v === "number") rec[field] = v + x;
        else if (typeof v === "string") {
          if (/^[0-9a-f]+$/.test(v) && field !== "doc") {
            const b = Buffer.from(v, "hex");
            b[x % b.length] = (b[x % b.length] as number) ^ 0xff;
            rec[field] = b.toString("hex");
          } else if (field === "doc") rec[field] = v + "x";
          else {
            const b = Buffer.from(v, "base64");
            b[x % b.length] = (b[x % b.length] as number) ^ x;
            rec[field] = b.toString("base64");
          }
        }
        const r = await verifyLedger(lines, trust);
        return !r.ok;
      }),
      { numRuns: 400 },
    );
  });

  it("deleting any single record is detected, except the newest checkpoint (the documented limit)", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, fc.nat(), async (s, pick) => {
        const f = await build(s);
        const lines = parse(f.lines());
        const lastCheckpoint = lines.map((o) => (o as { t: string }).t).lastIndexOf("checkpoint");
        const idx = lines.map((o, i) => [o as { t: string }, i] as const).filter(([o, i]) => o.t !== "meta" && i !== lastCheckpoint).map(([, i]) => i);
        lines.splice(idx[pick % idx.length] as number, 1);
        return !(await verifyLedger(lines, trust)).ok;
      }),
      { numRuns: 300 },
    );
  });

  it("swapping any two adjacent entries of one document is detected", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, fc.nat(), async (s, pick) => {
        const f = await build(s);
        const lines = parse(f.lines()) as { t: string; doc?: string }[];
        const pairs: number[] = [];
        for (let i = 0; i + 1 < lines.length; i++) if (lines[i]?.t === "entry" && lines[i + 1]?.t === "entry" && lines[i]?.doc === lines[i + 1]?.doc) pairs.push(i);
        if (pairs.length === 0) return true;
        const i = pairs[pick % pairs.length] as number;
        [lines[i], lines[i + 1]] = [lines[i + 1] as never, lines[i] as never];
        return !(await verifyLedger(lines, trust)).ok;
      }),
      { numRuns: 200 },
    );
  });

  it("never throws on arbitrary records", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.anything(), { maxLength: 8 }), async (junk) => {
        const r = await verifyLedger(junk, trust);
        return typeof r.ok === "boolean";
      }),
      { numRuns: 200 },
    );
  });

  it("is deterministic and independent of the trust-key order", async () => {
    const f = await healthy();
    const a = await verifyLedger(parse(f.lines()), { issuers: [stranger.publicKey, issuer.publicKey], ledgerKeys: [stranger.publicKey, ledger.publicKey] });
    const b = await run(f.lines());
    expect(a).toEqual(b);
  });
});
