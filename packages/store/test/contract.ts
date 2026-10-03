import { describe, expect, it } from "vitest";
import type { DocumentStore, NewUpdate } from "../src/index.js";

const key = (n: number) => new Uint8Array(8).fill(n);
export const upd = (clientSeq: number, opts: { session?: number; key?: number; byte?: number } = {}): NewUpdate => ({
  keyId: key(opts.key ?? 1),
  sessionId: opts.session ?? 1,
  clientSeq,
  frame: new Uint8Array([opts.byte ?? clientSeq, 0xaa]),
});

/** Behaviour every DocumentStore must have, run against memory and Postgres alike. */
export function documentStoreContract(name: string, make: () => Promise<DocumentStore>): void {
  describe(`${name} DocumentStore contract`, () => {
    it("assigns gapless increasing seqs and returns frames byte for byte", async () => {
      const s = await make();
      const r = await s.appendUpdates("d", [upd(1), upd(2), upd(3)]);
      expect(r).toEqual([
        { status: "appended", seq: 1 },
        { status: "appended", seq: 2 },
        { status: "appended", seq: 3 },
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

    it("ping succeeds on a healthy store", async () => {
      const s = await make();
      await expect(s.ping()).resolves.toBeUndefined();
      await s.close();
    });
  });
}
