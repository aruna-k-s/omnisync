import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decodeFrame } from "@omnisync/protocol";
import { OmniSyncClient } from "../src/client.js";
import { createDeviceKey } from "../src/keys.js";
import { MemoryOutbox } from "../src/outbox.js";
import type { SyncDocument } from "../src/document.js";
import { World, sleep, until } from "./harness.js";

type Action =
  | { t: "text"; who: 0 | 1; pos: number; ch: string }
  | { t: "delete"; who: 0 | 1; pos: number }
  | { t: "map"; who: 0 | 1; key: string; value: number }
  | { t: "arr"; who: 0 | 1; value: number }
  | { t: "offline"; who: 0 | 1 }
  | { t: "online"; who: 0 | 1 }
  | { t: "reload"; who: 0 | 1 }
  | { t: "sleep"; ms: number };

const who = fc.constantFrom<0 | 1>(0, 1);
const action: fc.Arbitrary<Action> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ t: fc.constant("text" as const), who, pos: fc.nat(1000), ch: fc.constantFrom("a", "b", "c", "é", "😀") }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("delete" as const), who, pos: fc.nat(1000) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("map" as const), who, key: fc.constantFrom("a", "b", "list", "constructor"), value: fc.integer({ min: -5, max: 5 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("arr" as const), who, value: fc.integer({ min: 0, max: 9 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("offline" as const), who }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("online" as const), who }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("reload" as const), who }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("sleep" as const), ms: fc.integer({ min: 0, max: 25 }) }) },
);

const canon = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)]));
  return v;
};

describe("property: edits, disconnects and reloads never lose, duplicate or reorder anything", () => {
  it(
    "two devices converge; the gateway log holds every edit exactly once, in order per session",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: 40 }), async (actions) => {
          const world = new World();
          const { url, gateway } = await world.start();
          const clients: OmniSyncClient[] = [];
          const outboxes = [new MemoryOutbox(), new MemoryOutbox()];
          const docs: SyncDocument[] = [];
          try {
            for (const i of [0, 1] as const) {
              const key = await createDeviceKey();
              const { certificate } = await world.enroll(await world.person(`u${i}`), key, { doc: "write" });
              const c = new OmniSyncClient({
                url,
                key,
                certificate,
                outbox: () => outboxes[i] as MemoryOutbox,
                tuning: { batch: { minMs: 2, maxMs: 15 }, backoff: { baseMs: 5, maxMs: 40 }, syncTimeoutMs: 1500 },
              });
              clients.push(c);
              docs.push(await c.open("doc"));
            }
            let edits = 0;
            const run = (fn: () => void) => {
              try {
                fn();
                edits++;
              } catch (e) {
                if (!(e instanceof RangeError)) throw e; // a refused edit is fine; anything else is a bug
              }
            };
            for (const a of actions) {
              if (a.t === "sleep") {
                await sleep(a.ms);
                continue;
              }
              const d = docs[a.who] as SyncDocument;
              switch (a.t) {
                case "text":
                  run(() => d.insertText(a.pos % (d.text.length + 1) === d.text.length ? d.text.length : lowSurrogateSafe(d.text, a.pos % (d.text.length + 1)), a.ch));
                  break;
                case "delete":
                  if (d.text.length > 0) run(() => d.deleteText(lowSurrogateSafe(d.text, a.pos % d.text.length), 1));
                  break;
                case "map":
                  run(() => d.mapSet([], a.key, a.key === "list" ? [] : a.value));
                  break;
                case "arr":
                  run(() => d.arrayInsert(["list"], 0, [a.value]));
                  break;
                case "offline":
                  d.disconnect();
                  break;
                case "online":
                  d.connect();
                  break;
                case "reload": {
                  await d.close();
                  docs[a.who] = await (clients[a.who] as OmniSyncClient).open("doc");
                  break;
                }
              }
            }
            for (const d of docs) d.connect();
            await Promise.all(docs.map((d) => d.synced()));
            // Quiet: every edit acknowledged, so the rest is relay. Wait for both replicas to catch up.
            await until(
              () => docs[0]!.text === docs[1]!.text && JSON.stringify(canon(docs[0]!.data)) === JSON.stringify(canon(docs[1]!.data)) && docs[0]!.text === gateway.textOf("doc"),
              8000,
              "convergence",
            );
            expect(docs[0]!.pending + docs[1]!.pending).toBe(0);

            const rows = await world.store.readUpdates("doc", 0, 100_000);
            const ids = rows.map((r) => {
              const f = decodeFrame(r.frame);
              return { s: f.sessionId, q: f.seq };
            });
            expect(rows.length).toBe(edits); // each edit stored exactly once
            expect(new Set(ids.map((i) => `${i.s}:${i.q}`)).size).toBe(ids.length);
            const lastBySession = new Map<number, number>();
            for (const { s, q } of ids) {
              expect(q).toBe((lastBySession.get(s) ?? 0) + 1); // in order, no gaps
              lastBySession.set(s, q);
            }
            for (const o of outboxes) expect(await o.pending()).toEqual([]);
          } finally {
            await Promise.allSettled(clients.map((c) => c.close()));
            await world.cleanup();
          }
        }),
        { numRuns: 25, interruptAfterTimeLimit: 100_000 },
      );
    },
    120_000,
  );
});

/** Avoids cutting a surrogate pair in half: the engine refuses it the same way for every replica. */
function lowSurrogateSafe(text: string, i: number): number {
  const c = text.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff && i > 0 ? i - 1 : i;
}
