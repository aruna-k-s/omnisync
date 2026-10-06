import { describe, expect, it } from "vitest";
import { createPrivateKey, generateKeyPairSync, sign as edSign } from "node:crypto";
import { ZERO_HASH, checkpointHash, entryHash, hashBytes, signCheckpoint, type LedgerSigner } from "@omnisync/crypto";
import type { DocumentStore, LedgerStore, NewCheckpoint, NewUpdate } from "../src/index.js";

const key = (n: number) => new Uint8Array(8).fill(n);
export const upd = (clientSeq: number, opts: { session?: number; key?: number; byte?: number } = {}): NewUpdate => ({
  keyId: key(opts.key ?? 1),
  sessionId: opts.session ?? 1,
  clientSeq,
  frame: new Uint8Array([opts.byte ?? clientSeq, 0xaa]),
  payloadHash: new Uint8Array(32).fill(opts.byte ?? clientSeq),
  receivedAtMs: 1_800_000_000_000 + clientSeq,
});

type Store = DocumentStore & LedgerStore;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const ledgerPair = generateKeyPairSync("ed25519");
const ledgerSigner: LedgerSigner = {
  keyId: new Uint8Array(8).fill(9),
  publicKey: Buffer.from(ledgerPair.publicKey.export({ format: "jwk" }).x as string, "base64url"),
  sign: (m) => edSign(null, m, createPrivateKey(ledgerPair.privateKey.export({ format: "pem", type: "pkcs8" }))),
};
export type Heads = { documentId: string; seq: number; headHash: Uint8Array }[];
/** A real signed checkpoint. The store refuses reservations whose bytes disagree with their fields. */
export async function checkpoint(n: number, prevHash: Uint8Array, heads: Heads, createdAtMs = 1_800_000_100_000 + n): Promise<NewCheckpoint> {
  const bytes = await signCheckpoint({ n, createdAtMs, prevCheckpointHash: prevHash, tenant: "t", heads }, ledgerSigner);
  return { n, createdAtMs, prevHash, hash: checkpointHash(bytes), bytes, heads };
}

/** Behaviour every DocumentStore must have, run against memory and Postgres alike. */
export function documentStoreContract(name: string, make: () => Promise<Store>): void {
  describe(`${name} DocumentStore contract`, () => {
    it("assigns gapless increasing seqs and returns frames byte for byte", async () => {
      const s = await make();
      const r = await s.appendUpdates("d", [upd(1), upd(2), upd(3)]);
      expect(r.map((x) => [x.status, x.status === "appended" ? x.seq : 0])).toEqual([
        ["appended", 1],
        ["appended", 2],
        ["appended", 3],
      ]);
      expect(await s.headSeq("d")).toBe(3);
      const rows = await s.readUpdates("d", 0, 100);
      expect(rows.map((u) => u.seq)).toEqual([1, 2, 3]);
      expect([...(rows[1]?.frame ?? [])]).toEqual([2, 0xaa]);
      await s.close();
    });

    it("keeps the signing certificate serial with the update", async () => {
      const s = await make();
      const serial = new Uint8Array(16).fill(5);
      await s.appendUpdates("d", [{ ...upd(1), certSerial: serial }, upd(2)]);
      const rows = await s.readUpdates("d", 0, 10);
      expect([...(rows[0]?.certSerial ?? [])]).toEqual([...serial]);
      expect(rows[1]?.certSerial).toBeUndefined();
      await s.close();
    });

    it("pages with afterSeq and limit", async () => {
      const s = await make();
      await s.appendUpdates("d", Array.from({ length: 10 }, (_, i) => upd(i + 1)));
      expect((await s.readUpdates("d", 0, 4)).map((u) => u.seq)).toEqual([1, 2, 3, 4]);
      expect((await s.readUpdates("d", 4, 4)).map((u) => u.seq)).toEqual([5, 6, 7, 8]);
      expect((await s.readUpdates("d", 8, 4)).map((u) => u.seq)).toEqual([9, 10]);
      expect(await s.readUpdates("d", 10, 4)).toEqual([]);
      await s.close();
    });

    it("answers duplicate for a stored client seq and replay for an older unstored one", async () => {
      const s = await make();
      await s.appendUpdates("d", [upd(1), upd(3)]);
      const r = await s.appendUpdates("d", [upd(1), upd(3), upd(2), upd(4)]);
      expect(r.map((x) => x.status)).toEqual(["duplicate", "duplicate", "replay", "appended"]);
      expect(await s.headSeq("d")).toBe(3);
      await s.close();
    });

    it("treats a repeat inside one batch as a duplicate", async () => {
      const s = await make();
      const r = await s.appendUpdates("d", [upd(1), upd(1)]);
      expect(r.map((x) => x.status)).toEqual(["appended", "duplicate"]);
      expect((await s.readUpdates("d", 0, 10)).length).toBe(1);
      await s.close();
    });

    it("tracks replay per key and per session independently", async () => {
      const s = await make();
      await s.appendUpdates("d", [upd(5)]);
      const r = await s.appendUpdates("d", [upd(1, { session: 2 }), upd(1, { key: 2 })]);
      expect(r.map((x) => x.status)).toEqual(["appended", "appended"]);
      await s.close();
    });

    it("keeps documents isolated", async () => {
      const s = await make();
      await s.appendUpdates("a", [upd(1)]);
      await s.appendUpdates("b", [upd(1), upd(2)]);
      expect(await s.headSeq("a")).toBe(1);
      expect(await s.headSeq("b")).toBe(2);
      expect(await s.headSeq("never")).toBe(0);
      expect(await s.readUpdates("never", 0, 10)).toEqual([]);
      await s.close();
    });

    it("records snapshots with increasing versions, newest first", async () => {
      const s = await make();
      const meta = (upToSeq: number) => ({
        objectKey: `k${upToSeq}`,
        sha256: new Uint8Array(32).fill(upToSeq),
        upToSeq,
        stateVector: new Uint8Array([upToSeq]),
        sizeBytes: 10 * upToSeq,
      });
      expect(await s.recordSnapshot("d", meta(5))).toBe(1);
      expect(await s.recordSnapshot("d", meta(9))).toBe(2);
      const list = await s.listSnapshots("d", 5);
      expect(list.map((x) => [x.version, x.upToSeq, x.objectKey])).toEqual([
        [2, 9, "k9"],
        [1, 5, "k5"],
      ]);
      expect([...(list[0]?.sha256 ?? [])]).toEqual(Array(32).fill(9));
      expect((await s.listSnapshots("d", 1)).length).toBe(1);
      expect(await s.listSnapshots("other", 5)).toEqual([]);
      await s.close();
    });

    it("chains every entry: prev hash links, entry hash recomputes, frame hash covers the stored bytes", async () => {
      const s = await make();
      const serial = new Uint8Array(16).fill(9);
      await s.appendUpdates("d", [{ ...upd(1), certSerial: serial }, upd(2), upd(3)]);
      await s.appendUpdates("d", [upd(4)]);
      const rows = await s.readUpdates("d", 0, 10);
      expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
      let prev = ZERO_HASH;
      for (const r of rows) {
        expect(hex(r.prevHash)).toBe(hex(prev));
        expect(hex(r.frameHash)).toBe(hex(hashBytes(r.frame)));
        expect(r.keyEpoch).toBe(0);
        expect(r.receivedAtMs).toBe(1_800_000_000_000 + r.seq);
        const expected = entryHash({
          documentId: "d",
          seq: r.seq,
          prevHash: prev,
          receivedAtMs: r.receivedAtMs,
          keyEpoch: r.keyEpoch,
          certSerial: r.certSerial,
          frameHash: r.frameHash,
          payloadHash: r.payloadHash,
        });
        expect(hex(r.entryHash)).toBe(hex(expected));
        prev = r.entryHash;
      }
      expect(rows[0]?.certSerial && hex(rows[0].certSerial)).toBe(hex(serial));
      await s.close();
    });

    it("returns the entry hash from append and keeps chains per document independent", async () => {
      const s = await make();
      const [a] = await s.appendUpdates("a", [upd(1)]);
      const [b] = await s.appendUpdates("b", [upd(1)]);
      const rowA = (await s.readUpdates("a", 0, 1))[0];
      expect(a?.status === "appended" && hex(a.entryHash)).toBe(hex(rowA?.entryHash ?? new Uint8Array()));
      expect(a?.status === "appended" && b?.status === "appended" && hex(a.entryHash) !== hex(b.entryHash)).toBe(true);
      expect(hex((await s.readUpdates("b", 0, 1))[0]?.prevHash ?? new Uint8Array(1))).toBe(hex(ZERO_HASH));
      await s.close();
    });

    it("a duplicate or replay changes no chain state", async () => {
      const s = await make();
      await s.appendUpdates("d", [upd(1), upd(3)]);
      const before = await s.readUpdates("d", 0, 10);
      await s.appendUpdates("d", [upd(1), upd(2), upd(3)]);
      expect(await s.readUpdates("d", 0, 10)).toEqual(before);
      const [next] = await s.appendUpdates("d", [upd(4)]);
      expect(next?.status === "appended" && next.seq).toBe(3);
      expect(hex((await s.readUpdates("d", 2, 1))[0]?.prevHash ?? new Uint8Array(1))).toBe(hex(before[1]?.entryHash ?? new Uint8Array()));
      await s.close();
    });

    it("refuses a malformed batch before storing anything", async () => {
      const s = await make();
      await expect(s.appendUpdates("d", [upd(1), { ...upd(2), payloadHash: new Uint8Array(5) }])).rejects.toThrow(RangeError);
      await expect(s.appendUpdates("d", [{ ...upd(1), certSerial: new Uint8Array(3) }])).rejects.toThrow(RangeError);
      expect(await s.headSeq("d")).toBe(0);
      await s.close();
    });

    it("lists documents in byte order and pages with a cursor", async () => {
      const s = await make();
      for (const id of ["b", "a", "B", "ä", "a1"]) await s.appendUpdates(id, [upd(1)]);
      expect(await s.listDocuments(undefined, 10)).toEqual(["B", "a", "a1", "b", "ä"]);
      expect(await s.listDocuments("a", 2)).toEqual(["a1", "b"]);
      expect(await s.listDocuments("ä", 2)).toEqual([]);
      await s.close();
    });

    it("orders pending heads by UTF-8 bytes, whatever the database collation", async () => {
      const s = await make();
      for (const id of ["b", "a", "B", "ä", "a1"]) await s.appendUpdates(id, [upd(1)]);
      expect((await s.pendingHeads(10)).map((h) => h.documentId)).toEqual(["B", "a", "a1", "b", "ä"]);
      expect((await s.pendingHeads(2)).map((h) => h.documentId)).toEqual(["B", "a"]);
      await s.close();
    });

    it("reports pending heads and entry counts until a checkpoint covers them", async () => {
      const s = await make();
      expect(await s.pendingHeads(10)).toEqual([]);
      expect(await s.lastCheckpoint()).toBeUndefined();
      await s.appendUpdates("b", [upd(1), upd(2)]);
      await s.appendUpdates("a", [upd(1)]);
      const heads = await s.pendingHeads(10);
      expect(heads.map((h) => [h.documentId, h.seq])).toEqual([["a", 1], ["b", 2]]);
      expect(await s.pendingEntries()).toBe(3);
      expect((await s.pendingHeads(1)).length).toBe(1);

      expect(await s.reserveCheckpoint(await checkpoint(1, ZERO_HASH, heads))).toBe(true);
      expect(await s.pendingHeads(10)).toEqual([]);
      expect(await s.pendingEntries()).toBe(0);
      const last = await s.lastCheckpoint();
      expect(last?.n).toBe(1);
      expect(last?.uploadedAtMs).toBeUndefined();

      await s.appendUpdates("b", [upd(3)]);
      expect((await s.pendingHeads(10)).map((h) => [h.documentId, h.seq])).toEqual([["b", 3]]);
      expect(await s.pendingEntries()).toBe(1);
      await s.close();
    });

    it("reserves checkpoints in order, once, with the right previous hash", async () => {
      const s = await make();
      await s.appendUpdates("a", [upd(1)]);
      const heads = await s.pendingHeads(10);
      expect(await s.reserveCheckpoint(await checkpoint(2, ZERO_HASH, heads))).toBe(false); // skips n = 1
      expect(await s.reserveCheckpoint(await checkpoint(1, new Uint8Array(32).fill(1), heads))).toBe(false); // wrong prev
      expect(await s.pendingEntries()).toBe(1); // a refused reservation advanced nothing
      const first = await checkpoint(1, ZERO_HASH, heads);
      expect(await s.reserveCheckpoint(first)).toBe(true);
      expect(await s.reserveCheckpoint(first)).toBe(false); // n is never reused
      await s.appendUpdates("a", [upd(2)]);
      expect(await s.reserveCheckpoint(await checkpoint(2, new Uint8Array(32).fill(7), await s.pendingHeads(10)))).toBe(false);
      expect(await s.reserveCheckpoint(await checkpoint(2, first.hash, await s.pendingHeads(10)))).toBe(true);
      expect((await s.listCheckpoints(0, 10)).map((c) => c.n)).toEqual([1, 2]);
      expect((await s.listCheckpoints(1, 10)).map((c) => c.n)).toEqual([2]);
      await s.close();
    });

    it("refuses a checkpoint that attests a head ahead of the log, and advances nothing", async () => {
      const s = await make();
      await s.appendUpdates("a", [upd(1)]);
      const bad = [
        { documentId: "a", seq: 1, headHash: new Uint8Array(32) },
        { documentId: "a-ghost", seq: 1, headHash: new Uint8Array(32) },
      ];
      expect(await s.reserveCheckpoint(await checkpoint(1, ZERO_HASH, bad))).toBe(false);
      expect(await s.reserveCheckpoint(await checkpoint(1, ZERO_HASH, [{ documentId: "a", seq: 2, headHash: new Uint8Array(32) }]))).toBe(false);
      expect(await s.pendingEntries()).toBe(1);
      expect(await s.lastCheckpoint()).toBeUndefined();
      await s.close();
    });

    it("refuses a stale or empty checkpoint: every head must move strictly forward", async () => {
      const s = await make();
      await s.appendUpdates("a", [upd(1)]);
      await s.appendUpdates("b", [upd(1)]);
      const heads = await s.pendingHeads(10);
      const first = await checkpoint(1, ZERO_HASH, heads);
      expect(await s.reserveCheckpoint(first)).toBe(true);
      // A second writer that read the same heads before the first committed arrives late with the next n.
      expect(await s.reserveCheckpoint(await checkpoint(2, first.hash, heads))).toBe(false);
      // Partially stale is refused too: b has moved on, a has not.
      await s.appendUpdates("b", [upd(2)]);
      const moved = (await s.pendingHeads(10)).find((h) => h.documentId === "b");
      const mixed = [heads[0] as (typeof heads)[number], moved as NonNullable<typeof moved>];
      expect(await s.reserveCheckpoint(await checkpoint(2, first.hash, mixed))).toBe(false);
      expect(await s.reserveCheckpoint(await checkpoint(2, first.hash, []))).toBe(false);
      expect((await s.listCheckpoints(0, 10)).map((c) => c.n)).toEqual([1]);
      expect(await s.pendingEntries()).toBe(1);
      await s.close();
    });

    it("refuses a reservation that lies: bytes that disagree with the fields, a made-up head hash, or time running backwards", async () => {
      const s = await make();
      await s.appendUpdates("a", [upd(1)]);
      const heads = await s.pendingHeads(10);
      const good = await checkpoint(1, ZERO_HASH, heads);
      // The signed bytes say n = 1 but the row claims n = 1 with different heads, hash, prev or time.
      expect(await s.reserveCheckpoint({ ...good, hash: new Uint8Array(32).fill(5) })).toBe(false);
      expect(await s.reserveCheckpoint({ ...good, bytes: good.bytes.slice(0, good.bytes.length - 1) })).toBe(false);
      expect(await s.reserveCheckpoint({ ...good, createdAtMs: good.createdAtMs + 1 })).toBe(false);
      const fake = [{ documentId: "a", seq: 1, headHash: new Uint8Array(32).fill(3) }];
      expect(await s.reserveCheckpoint(await checkpoint(1, ZERO_HASH, fake))).toBe(false); // self-consistent, but not the real entry hash
      expect(await s.reserveCheckpoint({ ...good, heads: [] })).toBe(false);
      expect(await s.pendingEntries()).toBe(1);
      expect(await s.reserveCheckpoint(good)).toBe(true);
      await s.appendUpdates("a", [upd(2)]);
      expect(await s.reserveCheckpoint(await checkpoint(2, good.hash, await s.pendingHeads(10), good.createdAtMs - 1))).toBe(false);
      expect(await s.reserveCheckpoint(await checkpoint(2, good.hash, await s.pendingHeads(10), good.createdAtMs))).toBe(true); // equal time is fine
      await s.close();
    });

    it("tracks uploads separately and never loses a reserved checkpoint", async () => {
      const s = await make();
      await s.appendUpdates("a", [upd(1)]);
      await s.reserveCheckpoint(await checkpoint(1, ZERO_HASH, await s.pendingHeads(10)));
      expect((await s.unuploadedCheckpoints(10)).map((c) => c.n)).toEqual([1]);
      await s.markCheckpointUploaded(1, 5);
      await s.markCheckpointUploaded(1, 9); // idempotent; the first time stands
      expect(await s.unuploadedCheckpoints(10)).toEqual([]);
      expect((await s.lastCheckpoint())?.uploadedAtMs).toBe(5);
      await s.close();
    });

    it("ping succeeds on a healthy store", async () => {
      const s = await make();
      await expect(s.ping()).resolves.toBeUndefined();
      await s.close();
    });
  });
}
