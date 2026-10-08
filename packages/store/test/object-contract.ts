import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ObjectStore } from "../src/index.js";

const b = (...n: number[]) => new Uint8Array(n);
let counter = 0;
/** A key no earlier test used, so one backend can serve every test without cleanup. */
const fresh = (prefix = "snapshots/t"): string => `${prefix}/${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}.bin`;

/**
 * What every ObjectStore promises. `make` returns a store whose keys under `snapshots/` can be overwritten and deleted.
 */
export function objectStoreContract(name: string, make: () => Promise<ObjectStore>): void {
  describe(`object store contract: ${name}`, () => {
    it("round-trips bytes and reports a missing object as undefined", async () => {
      const o = await make();
      const k = fresh();
      expect(await o.get(k)).toBeUndefined();
      await o.put(k, b(1, 2, 3));
      expect([...((await o.get(k)) ?? [])]).toEqual([1, 2, 3]);
    });

    it("stores empty and binary objects exactly", async () => {
      const o = await make();
      const k1 = fresh();
      const k2 = fresh();
      await o.put(k1, new Uint8Array(0));
      const all = Uint8Array.from({ length: 256 }, (_, i) => i);
      await o.put(k2, all);
      expect((await o.get(k1))?.length).toBe(0);
      expect([...((await o.get(k2)) ?? [])]).toEqual([...all]);
    });

    it("put overwrites, delete removes, and deleting a missing key is not an error", async () => {
      const o = await make();
      const k = fresh();
      await o.put(k, b(1));
      await o.put(k, b(9));
      expect([...((await o.get(k)) ?? [])]).toEqual([9]);
      await o.delete(k);
      expect(await o.get(k)).toBeUndefined();
      await o.delete(k);
    });

    it("putIfAbsent creates once and leaves the first bytes in place", async () => {
      const o = await make();
      const k = fresh();
      expect(await o.putIfAbsent(k, b(1, 1))).toBe(true);
      expect(await o.putIfAbsent(k, b(2, 2))).toBe(false);
      expect(await o.putIfAbsent(k, b(1, 1))).toBe(false);
      expect([...((await o.get(k)) ?? [])]).toEqual([1, 1]);
    });

    it("putIfAbsent does not copy the caller's buffer into the store by reference", async () => {
      const o = await make();
      const k = fresh();
      const mine = b(5, 5, 5);
      await o.putIfAbsent(k, mine);
      mine[0] = 0;
      expect([...((await o.get(k)) ?? [])]).toEqual([5, 5, 5]);
    });

    it("exactly one of many parallel putIfAbsent calls wins, and the stored bytes are the winner's", async () => {
      const o = await make();
      await fc.assert(
        fc.asyncProperty(fc.array(fc.uint8Array({ minLength: 1, maxLength: 24 }), { minLength: 2, maxLength: 12 }), async (candidates) => {
          const k = fresh();
          const results = await Promise.all(candidates.map((c) => o.putIfAbsent(k, c)));
          expect(results.filter(Boolean)).toHaveLength(1);
          const stored = await o.get(k);
          const winner = candidates[results.indexOf(true)] as Uint8Array;
          expect([...(stored ?? [])]).toEqual([...winner]);
        }),
        { numRuns: 12 },
      );
    });

    it("rejects hostile keys before touching storage", async () => {
      const o = await make();
      for (const k of ["", "/abs", "../escape", "a/../../b", "a\\b", "a\0b", "x".repeat(1025), "\ud800"]) {
        await expect(o.put(k, b(1)), JSON.stringify(k)).rejects.toThrow();
        await expect(o.putIfAbsent(k, b(1)), JSON.stringify(k)).rejects.toThrow();
        await expect(o.get(k), JSON.stringify(k)).rejects.toThrow();
        await expect(o.delete(k), JSON.stringify(k)).rejects.toThrow();
      }
    });

    it("accepts the keys the product uses", async () => {
      const o = await make();
      for (const k of [fresh("snapshots/6162"), fresh("checkpoints/61636d65")]) {
        // A locked store would keep this key; the contract only needs the write to be accepted.
        await o.putIfAbsent(k, b(7));
        expect([...((await o.get(k)) ?? [])]).toEqual([7]);
      }
    });
  });
}
