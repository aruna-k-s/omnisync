import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPair, signUpdate } from "@omnisync/protocol";
import { checkpointObjectKey, ledgerSignerFromKeyPair } from "@omnisync/crypto";
import { MemoryObjectStore, type LedgerStore } from "@omnisync/store";
import { GatewayMetrics, Tracing } from "@omnisync/telemetry";
import { SPAN_ERROR, sample, series, testMeter, testTracer } from "@omnisync/telemetry/testing";
import { CheckpointWriter, type GatewayClient } from "../src/index.js";
import { TestClock, TestIdentity, connectAs, connectClient, issuerKey, ledgerKey, makeWorld, startGateway, until, keys, type Running } from "./harness.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f().catch(() => {});
});

async function rig(over: { docId?: string } = {}) {
  const world = await makeWorld("memory");
  const m = testMeter();
  const t = testTracer();
  const r = await startGateway(world, { metrics: new GatewayMetrics(m.meter), tracing: new Tracing(t.tracer) });
  const clients: GatewayClient[] = [];
  cleanups.push(async () => {
    await Promise.allSettled(clients.splice(0).map((c) => c.close()));
    await r.gateway.close();
    await m.shutdown();
    await t.shutdown();
    await world.cleanup();
  });
  const connect = async (actor: number, docId = over.docId ?? "doc") => {
    const c = await connectClient(r.url, actor, "yjs", { docId });
    clients.push(c);
    return c;
  };
  const metric = async (name: string, labels: Record<string, string> = {}) => sample(await m.scrape(), name, labels);
  return { world, r, m, t, connect, metric, clients };
}

describe("gateway metrics on the edit path", () => {
  it("records timings, durability and gauges for a normal edit", async () => {
    const { connect, metric, m } = await rig();
    const a = await connect(1);
    const b = await connect(2);
    await a.insert(0, "hello");
    await until(() => b.doc.getText() === "hello");
    const text = await m.scrape();
    expect(sample(text, "omnisync_update_apply_seconds_count", { outcome: "ok" })).toBe(1);
    expect(sample(text, "omnisync_ledger_append_seconds_count", { outcome: "ok" })).toBe(1);
    expect(sample(text, "omnisync_fanout_seconds_count")).toBe(1);
    expect(sample(text, "omnisync_updates_total", { outcome: "persisted" })).toBe(1);
    expect(await metric("omnisync_connections_active")).toBe(2);
    expect(await metric("omnisync_documents_active")).toBe(1);
    expect(await metric("omnisync_store_degraded")).toBe(0);
    expect(await metric("omnisync_append_queue_depth")).toBe(0);
  });

  it("gauges fall when clients leave", async () => {
    const { connect, metric, clients } = await rig();
    const a = await connect(1);
    await connect(2);
    await a.close();
    clients.shift();
    await new Promise((r) => setTimeout(r, 50));
    expect(await metric("omnisync_connections_active")).toBe(1);
  });

  it("counts a forged update as a signature failure and a refused update", async () => {
    const { connect, metric, t } = await rig();
    const a = await connect(1);
    const mallory = generateKeyPair(new Uint8Array(32).fill(99));
    const forged = signUpdate({ docId: "doc", sessionId: 1, claimedAtMs: 0, seq: 1, payload: a.doc.insertText(0, "evil") }, mallory);
    a.sendRaw(forged);
    await until(() => a.errors.includes("unknown_key"));
    expect(await metric("omnisync_signature_failures_total", { reason: "unknown_key" })).toBe(1);
    expect(await metric("omnisync_update_apply_seconds_count", { outcome: "rejected" })).toBe(1);
    expect(await metric("omnisync_update_apply_seconds_count", { outcome: "ok" })).toBeUndefined();
    const root = t.spans().find((s) => s.name === "omnisync.edit");
    expect(root?.attributes["omnisync.outcome"]).toBe("unknown_key");
    expect(root?.status.code).not.toBe(SPAN_ERROR);
  });

  it("shows queue depth while the store is slow, then drains it", async () => {
    const { connect, metric, world } = await rig();
    const a = await connect(1);
    world.store.delayMs = 400;
    const edits = [a.insert(0, "a"), a.insert(1, "b"), a.insert(2, "c")];
    let seen = 0;
    const end = Date.now() + 2000;
    while (Date.now() < end && seen === 0) {
      seen = (await metric("omnisync_append_queue_depth")) ?? 0;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(seen).toBeGreaterThan(0);
    world.store.delayMs = 0;
    await Promise.allSettled(edits);
    expect(await metric("omnisync_append_queue_depth")).toBe(0);
  });

  it("records a failed append as an error, degrades the store gauge and marks the span", async () => {
    const { connect, metric, world, t } = await rig();
    const a = await connect(1);
    world.store.down = true; // down, not a single failure: the client retries, and a success would clear the gauge
    void a.insert(0, "x").catch(() => {});
    await until(() => t.spans().some((s) => s.name === "omnisync.edit"));
    expect(await metric("omnisync_ledger_append_seconds_count", { outcome: "error" })).toBeGreaterThanOrEqual(1);
    expect(await metric("omnisync_update_apply_seconds_count", { outcome: "rejected" })).toBeGreaterThanOrEqual(1);
    const root = t.spans().find((s) => s.name === "omnisync.edit");
    expect(root?.status.code).toBe(SPAN_ERROR);
    expect(root?.attributes["omnisync.outcome"]).toBe("unavailable");
    expect(await metric("omnisync_store_degraded")).toBe(1);
    world.store.down = false;
    void a.insert(0, "y").catch(() => {}); // the next successful append clears it
    const end = Date.now() + 3000;
    while (Date.now() < end && (await metric("omnisync_store_degraded")) !== 0) await new Promise((r) => setTimeout(r, 20));
    expect(await metric("omnisync_store_degraded")).toBe(0);
  });

  it("counts a retried update once as persisted and once as a duplicate, and labels the trace", async () => {
    const { connect, metric, t } = await rig();
    const a = await connect(1);
    const frame = signUpdate({ docId: "doc", sessionId: 9, claimedAtMs: 0, seq: 1, payload: a.doc.insertText(0, "once") }, keys[1]!);
    a.sendRaw(frame);
    a.sendRaw(frame);
    await until(() => t.spans().filter((s) => s.name === "omnisync.edit").length === 2);
    expect(await metric("omnisync_updates_total", { outcome: "persisted" })).toBe(1);
    expect(await metric("omnisync_updates_total", { outcome: "duplicate" })).toBe(1);
    const outcomes = t.spans().filter((s) => s.name === "omnisync.edit").map((s) => s.attributes["omnisync.outcome"]).sort();
    expect(outcomes).toEqual(["duplicate", "ok"]);
    // a duplicate is acknowledged but not relayed, so only the fresh one has a fanout stage
    expect(t.spans().filter((s) => s.name === "fanout")).toHaveLength(1);
  });

  it("ends the verify stage before the append stage begins", async () => {
    const { connect, t, world } = await rig();
    const a = await connect(1);
    world.store.delayMs = 60; // the append takes long enough that a verify stage left open until the end would show
    await a.insert(0, "order");
    await until(() => t.spans().some((s) => s.name === "omnisync.edit"));
    const verify = t.spans().find((s) => s.name === "verify")!;
    const append = t.spans().find((s) => s.name === "append")!;
    const ms = (h: [number, number]) => h[0] * 1000 + h[1] / 1e6;
    expect(ms(verify.endTime)).toBeLessThanOrEqual(ms(append.startTime) + 5);
    expect(ms(append.endTime) - ms(append.startTime)).toBeGreaterThanOrEqual(50);
  });

  it("counts the batch being written as queue depth", async () => {
    const { connect, metric, world } = await rig();
    const a = await connect(1);
    world.store.delayMs = 500;
    const edit = a.insert(0, "x"); // alone: nothing waits behind it, so only the in-flight count can show it
    let seen = 0;
    const end = Date.now() + 2000;
    while (Date.now() < end && seen !== 1) {
      seen = (await metric("omnisync_append_queue_depth")) ?? 0;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(seen).toBe(1);
    world.store.delayMs = 0;
    await edit;
    expect(await metric("omnisync_append_queue_depth")).toBe(0);
  });

  it("builds one trace per edit: edit, verify, append, fanout", async () => {
    const { connect, t } = await rig();
    const a = await connect(1);
    const b = await connect(2);
    await a.insert(0, "traced");
    await until(() => b.doc.getText() === "traced");
    await new Promise((r) => setTimeout(r, 50));
    const spans = t.spans();
    const root = spans.find((s) => s.name === "omnisync.edit");
    expect(root).toBeDefined();
    expect(spans.map((s) => s.name).sort()).toEqual(["append", "fanout", "omnisync.edit", "verify"]);
    for (const s of spans.filter((x) => x !== root)) {
      expect(s.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
    }
    expect(root?.attributes["omnisync.outcome"]).toBe("ok");
    expect(root?.attributes["omnisync.update.bytes"]).toBeGreaterThan(0);
  });

  it("records nothing sensitive: no document id, key, key id or payload anywhere", async () => {
    const docId = "secret-doc-name-7f3a";
    const { connect, m, t, metric } = await rig({ docId });
    const a = await connect(1);
    const b = await connect(2);
    await a.insert(0, "the-secret-document-text");
    await until(() => b.doc.getText().includes("secret"));
    const key = keys[1];
    const text = await m.scrape();
    const spans = JSON.stringify(t.spans().map((s) => ({ n: s.name, a: s.attributes, e: s.events, r: s.resource.attributes })));
    const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
    for (const haystack of [text, spans]) {
      expect(haystack).not.toContain(docId);
      expect(haystack).not.toContain("the-secret-document-text");
      expect(haystack).not.toContain(hex(key!.publicKey));
      expect(haystack).not.toContain(hex(key!.keyId));
      expect(haystack).not.toContain(Buffer.from(key!.publicKey).toString("base64"));
    }
    expect(await metric("omnisync_documents_active")).toBe(1);
  });

  it("series count stays bounded under a hostile client", async () => {
    const { connect, m } = await rig();
    const a = await connect(1);
    for (let i = 0; i < 200; i++) a.sendRaw(Uint8Array.from({ length: 20 + (i % 50) }, (_, j) => (i * 31 + j) & 255));
    a.sendRaw(Uint8Array.of(0xff));
    await new Promise((r) => setTimeout(r, 200));
    const text = await m.scrape();
    const count = text.split("\n").filter((l) => l && !l.startsWith("#")).length;
    expect(count).toBeLessThan(150);
    for (const labels of series(text, "omnisync_admission_rejections_total")) {
      expect(["rate_limited", "busy", "forbidden", "upload_only", "malformed", "claimed_time", "store_error", "other"]).toContain(labels["reason"]);
    }
  });
});

describe("observer only", () => {
  it("a meter and tracer that throw on every call do not change what the gateway does", async () => {
    const throwing = new Proxy({}, { get: () => () => { throw new Error("telemetry broke"); } }) as never;
    const world = await makeWorld("memory");
    const r = await startGateway(world, { metrics: new GatewayMetrics(throwing), tracing: new Tracing(throwing) });
    const a = await connectClient(r.url, 1, "yjs", { docId: "d" });
    const b = await connectClient(r.url, 2, "yjs", { docId: "d" });
    cleanups.push(async () => {
      await a.close();
      await b.close();
      await r.gateway.close();
      await world.cleanup();
    });
    await a.insert(0, "still works");
    await until(() => b.doc.getText() === "still works");
    expect(r.gateway.stats.accepted).toBe(1);
  });

  it("no telemetry configured: nothing changes", async () => {
    const world = await makeWorld("memory");
    const r = await startGateway(world);
    const a = await connectClient(r.url, 1, "yjs", { docId: "d" });
    cleanups.push(async () => {
      await a.close();
      await r.gateway.close();
      await world.cleanup();
    });
    await a.insert(0, "x");
    expect(r.gateway.stats.accepted).toBe(1);
  });
});

describe("authenticated connections", () => {
  async function authRig() {
    const world = await makeWorld("memory");
    const clock = new TestClock();
    const ids = new TestIdentity(world.identity, clock);
    const m = testMeter();
    const r: Running = await startGateway(world, {
      auth: { issuers: [issuerKey.publicKey], identity: world.identity, now: clock.now, revocationPollMs: 3_600_000 },
      metrics: new GatewayMetrics(m.meter),
    });
    cleanups.push(async () => {
      await r.gateway.close();
      await m.shutdown();
      await world.cleanup();
    });
    return { world, clock, ids, m, r };
  }

  it("counts successful and failed connections", async () => {
    const { ids, clock, m, r } = await authRig();
    const ok = await ids.enroll("alice", { doc: "write" });
    const nobody = await ids.enroll("nobody", {});
    const a = await connectAs(r.url, ok, clock, { docId: "doc" });
    await connectAs(r.url, nobody, clock, { docId: "doc" }).catch(() => {});
    await a.close();
    await until(() => r.gateway.stats.authFailures["no_access"] === 1);
    const text = await m.scrape();
    expect(sample(text, "omnisync_connections_total", { outcome: "ok" })).toBe(1);
    expect(sample(text, "omnisync_connections_total", { outcome: "failed" })).toBe(1);
  });

  it("counts an edit by a read-only person as a forbidden admission rejection", async () => {
    const { ids, clock, m, r } = await authRig();
    const reader = await ids.enroll("reader", { doc: "read" });
    const c = await connectAs(r.url, reader, clock, { docId: "doc" });
    cleanups.push(() => c.close());
    await c.insert(0, "nope").catch(() => {});
    await until(() => (r.gateway.stats.rejected["forbidden"] ?? 0) >= 1);
    expect(sample(await m.scrape(), "omnisync_admission_rejections_total", { reason: "forbidden" })).toBeGreaterThanOrEqual(1);
  });
});

describe("checkpoint writer observability", () => {
  async function ckRig() {
    const world = await makeWorld("memory");
    const clock = new TestClock();
    const objects = new MemoryObjectStore();
    const t = testTracer();
    const writer = new CheckpointWriter({
      store: world.rawStore as unknown as LedgerStore,
      objects,
      tenant: "acme",
      signer: ledgerSignerFromKeyPair(ledgerKey),
      now: clock.now,
      tracing: new Tracing(t.tracer),
    });
    const ids = new TestIdentity(world.identity, clock);
    const r = await startGateway(world, { auth: { issuers: [issuerKey.publicKey], identity: world.identity, now: clock.now, revocationPollMs: 3_600_000 } });
    cleanups.push(async () => {
      await r.gateway.close();
      await t.shutdown();
      await world.cleanup();
    });
    return { world, clock, objects, t, writer, ids, r };
  }

  it("starts counting from construction and resets when everything is covered", async () => {
    const { writer, clock, ids, r } = await ckRig();
    expect(writer.behindMs()).toBe(0);
    clock.advance(600_000);
    expect(writer.behindMs()).toBe(600_000);
    await writer.tick(); // nothing pending: caught up
    expect(writer.behindMs()).toBe(0);

    const e = await ids.enroll("alice", { doc: "write" });
    const c = await connectAs(r.url, e, clock, { docId: "doc" });
    cleanups.push(() => c.close());
    await c.insert(0, "x");
    clock.advance(30_000);
    await writer.tick(); // pending but not yet due: not caught up, and the age keeps growing
    expect(writer.behindMs()).toBe(30_000);
    clock.advance(300_000);
    await writer.tick(); // due: writes and uploads
    expect(writer.stats.uploaded).toBe(1);
    expect(writer.behindMs()).toBe(0);
  });

  it("does not reset the age while an upload is failing", async () => {
    const { writer, clock, ids, r, objects } = await ckRig();
    const e = await ids.enroll("alice", { doc: "write" });
    const c = await connectAs(r.url, e, clock, { docId: "doc" });
    cleanups.push(() => c.close());
    await c.insert(0, "x");
    const real = objects.putIfAbsent.bind(objects);
    objects.putIfAbsent = async () => {
      throw new Error("bucket down");
    };
    clock.advance(400_000);
    await writer.tick();
    expect(writer.stats.uploadFailures).toBe(1);
    expect(writer.behindMs()).toBe(400_000);
    clock.advance(60_000);
    await writer.tick();
    expect(writer.behindMs()).toBe(460_000);
    objects.putIfAbsent = real;
    await writer.tick();
    expect(writer.behindMs()).toBe(0);
  });

  it("traces each checkpoint as its own root with number and document count", async () => {
    const { writer, clock, ids, r, t } = await ckRig();
    const e = await ids.enroll("alice", { doc: "write" });
    const c = await connectAs(r.url, e, clock, { docId: "doc" });
    cleanups.push(() => c.close());
    await c.insert(0, "x");
    await writer.flush();
    const spans = t.spans().filter((s) => s.name === "omnisync.checkpoint");
    expect(spans).toHaveLength(1);
    expect(spans[0]?.parentSpanContext).toBeUndefined();
    expect(spans[0]?.attributes["omnisync.checkpoint.n"]).toBe(1);
    expect(spans[0]?.attributes["omnisync.checkpoint.documents"]).toBe(1);
    expect(spans[0]?.attributes["omnisync.outcome"]).toBe("ok");
  });

  it("never reports a negative age when the clock steps back", async () => {
    const { writer, clock } = await ckRig();
    clock.advance(-60_000);
    expect(writer.behindMs()).toBe(0);
  });

  it("marks a different object under the same number as a conflict, an error, and counts it", async () => {
    const { writer, clock, ids, r, t, objects } = await ckRig();
    const e = await ids.enroll("alice", { doc: "write" });
    const c = await connectAs(r.url, e, clock, { docId: "doc" });
    cleanups.push(() => c.close());
    await c.insert(0, "x");
    await objects.putIfAbsent(checkpointObjectKey("acme", 1), Uint8Array.of(1, 2, 3)); // someone else's bytes
    await writer.flush();
    expect(writer.stats.uploadConflicts).toBe(1);
    const s = t.spans().find((x) => x.name === "omnisync.checkpoint");
    expect(s?.attributes["omnisync.outcome"]).toBe("conflict");
    expect(s?.status.code).toBe(SPAN_ERROR);
    expect(writer.behindMs()).toBeGreaterThanOrEqual(0);
  });

  it("marks a failed upload as an error span", async () => {
    const { writer, clock, ids, r, t, objects } = await ckRig();
    const e = await ids.enroll("alice", { doc: "write" });
    const c = await connectAs(r.url, e, clock, { docId: "doc" });
    cleanups.push(() => c.close());
    await c.insert(0, "x");
    objects.putIfAbsent = async () => {
      throw new Error("bucket down");
    };
    await writer.flush();
    const s = t.spans().find((x) => x.name === "omnisync.checkpoint");
    expect(s?.status.code).toBe(SPAN_ERROR);
    expect(s?.attributes["omnisync.outcome"]).toBe("unavailable");
  });
});
