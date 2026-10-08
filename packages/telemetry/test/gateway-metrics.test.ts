import { afterEach, describe, expect, it } from "vitest";
import { GatewayMetrics, type CheckpointSource, type GatewayCounters, type GatewaySource } from "../src/gateway-metrics.js";
import { sample, series, testMeter } from "../src/testing.js";

const counters = (over: Partial<GatewayCounters> = {}): GatewayCounters => ({
  persisted: 0,
  duplicates: 0,
  snapshotFailures: 0,
  authenticated: 0,
  busyRejections: 0,
  authFailures: {},
  rejected: {},
  ...over,
});

function source(over: Partial<{ connections: number; documents: number; queue: number; degraded: boolean; c: GatewayCounters }> = {}): GatewaySource & { set: (o: typeof over) => void } {
  const state = { connections: 0, documents: 0, queue: 0, degraded: false, c: counters(), ...over };
  return {
    connections: () => state.connections,
    documents: () => state.documents,
    appendQueueDepth: () => state.queue,
    degraded: () => state.degraded,
    stats: () => state.c,
    set: (o) => Object.assign(state, o),
  };
}

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.map((f) => f()));
  cleanup = [];
});
function setup() {
  const t = testMeter();
  cleanup.push(t.shutdown);
  return { ...t, m: new GatewayMetrics(t.meter) };
}

describe("gauges", () => {
  it("read the live values at scrape time", async () => {
    const { m, scrape } = setup();
    const src = source({ connections: 3, documents: 2, queue: 7 });
    m.observe(src);
    let text = await scrape();
    expect(sample(text, "omnisync_connections_active")).toBe(3);
    expect(sample(text, "omnisync_documents_active")).toBe(2);
    expect(sample(text, "omnisync_append_queue_depth")).toBe(7);
    expect(sample(text, "omnisync_store_degraded")).toBe(0);
    src.set({ connections: 0, documents: 0, queue: 0, degraded: true });
    text = await scrape();
    expect(sample(text, "omnisync_connections_active")).toBe(0);
    expect(sample(text, "omnisync_append_queue_depth")).toBe(0);
    expect(sample(text, "omnisync_store_degraded")).toBe(1);
  });
  it("declares gauge types", async () => {
    const { m, scrape } = setup();
    m.observe(source());
    const text = await scrape();
    for (const n of ["omnisync_connections_active", "omnisync_documents_active", "omnisync_append_queue_depth", "omnisync_store_degraded"]) {
      expect(text).toContain(`# TYPE ${n} gauge`);
    }
  });
});

describe("counters derived from gateway stats", () => {
  it("reports persisted and duplicate updates", async () => {
    const { m, scrape } = setup();
    m.observe(source({ c: counters({ persisted: 5, duplicates: 2 }) }));
    const text = await scrape();
    expect(text).toContain("# TYPE omnisync_updates_total counter");
    expect(sample(text, "omnisync_updates_total", { outcome: "persisted" })).toBe(5);
    expect(sample(text, "omnisync_updates_total", { outcome: "duplicate" })).toBe(2);
  });
  it("reports connection results", async () => {
    const { m, scrape } = setup();
    m.observe(source({ c: counters({ authenticated: 4, authFailures: { bad_certificate: 2, timeout: 1 } }) }));
    const text = await scrape();
    expect(sample(text, "omnisync_connections_total", { outcome: "ok" })).toBe(4);
    expect(sample(text, "omnisync_connections_total", { outcome: "failed" })).toBe(3);
  });
  it("reports signature failures by reason and nothing else under that name", async () => {
    const { m, scrape } = setup();
    m.observe(source({ c: counters({ rejected: { bad_signature: 3, unknown_key: 2, not_update: 1, forbidden: 9, rate_limited: 4 } }) }));
    const text = await scrape();
    expect(sample(text, "omnisync_signature_failures_total", { reason: "bad_signature" })).toBe(3);
    expect(sample(text, "omnisync_signature_failures_total", { reason: "unknown_key" })).toBe(2);
    expect(sample(text, "omnisync_signature_failures_total", { reason: "not_update" })).toBe(1);
    expect(series(text, "omnisync_signature_failures_total")).toHaveLength(3);
  });
  it("groups admission rejections into the closed set", async () => {
    const { m, scrape } = setup();
    m.observe(
      source({
        c: counters({
          busyRejections: 6,
          rejected: {
            rate_limited: 4,
            forbidden: 9,
            upload_only: 1,
            malformed: 2,
            claimed_before_validity: 1,
            claimed_after_expiry: 2,
            claimed_in_future: 3,
            unavailable: 5,
            internal: 1,
            text_frame: 7,
            type_not_allowed: 1,
            bad_signature: 100,
          },
        }),
      }),
    );
    const text = await scrape();
    const r = (reason: string) => sample(text, "omnisync_admission_rejections_total", { reason });
    expect(r("rate_limited")).toBe(4);
    expect(r("busy")).toBe(6);
    expect(r("forbidden")).toBe(9);
    expect(r("upload_only")).toBe(1);
    expect(r("malformed")).toBe(2);
    expect(r("claimed_time")).toBe(6);
    expect(r("store_error")).toBe(6);
    expect(r("other")).toBe(8);
    // signature failures are not admission rejections
    const total = series(text, "omnisync_admission_rejections_total").reduce((n, s) => n + (sample(text, "omnisync_admission_rejections_total", s) ?? 0), 0);
    expect(total).toBe(4 + 6 + 9 + 1 + 2 + 6 + 6 + 8);
  });
  it("never makes a series from a client supplied reason", async () => {
    const { m, scrape } = setup();
    const hostile: Record<string, number> = {};
    for (let i = 0; i < 500; i++) hostile[`evil_${i}_${"x".repeat(50)}`] = 1;
    hostile["__proto__x"] = 1;
    hostile['a"b\nc'] = 1;
    m.observe(source({ c: counters({ rejected: hostile, authFailures: hostile }) }));
    const text = await scrape();
    expect(text).not.toContain("evil_");
    expect(series(text, "omnisync_admission_rejections_total").length).toBeLessThanOrEqual(8);
    expect(series(text, "omnisync_connections_total").length).toBeLessThanOrEqual(2);
    expect(sample(text, "omnisync_admission_rejections_total", { reason: "other" })).toBe(502);
  });
  it("reports snapshot failures", async () => {
    const { m, scrape } = setup();
    m.observe(source({ c: counters({ snapshotFailures: 3 }) }));
    expect(sample(await scrape(), "omnisync_snapshot_failures_total")).toBe(3);
  });
  it("counters only go up when the source does", async () => {
    const { m, scrape } = setup();
    const src = source({ c: counters({ persisted: 1 }) });
    m.observe(src);
    expect(sample(await scrape(), "omnisync_updates_total", { outcome: "persisted" })).toBe(1);
    src.set({ c: counters({ persisted: 4 }) });
    expect(sample(await scrape(), "omnisync_updates_total", { outcome: "persisted" })).toBe(4);
  });
});

describe("checkpoint metrics", () => {
  const cp = (s: Partial<ReturnType<CheckpointSource["stats"]>> = {}, behind = 0): CheckpointSource & { behind: number } => {
    const o = { behind, stats: { uploaded: 0, signFailures: 0, storeFailures: 0, uploadFailures: 0, uploadConflicts: 0, ...s } };
    return { stats: () => o.stats, behindSeconds: () => o.behind, get behind() { return o.behind; }, set behind(v: number) { o.behind = v; } };
  };
  it("reports uploads, failures by kind and age", async () => {
    const { m, scrape } = setup();
    m.observeCheckpoints(cp({ uploaded: 7, signFailures: 1, storeFailures: 2, uploadFailures: 3, uploadConflicts: 4 }, 42.5));
    const text = await scrape();
    expect(sample(text, "omnisync_checkpoints_total")).toBe(7);
    expect(sample(text, "omnisync_checkpoint_failures_total", { kind: "sign" })).toBe(1);
    expect(sample(text, "omnisync_checkpoint_failures_total", { kind: "store" })).toBe(2);
    expect(sample(text, "omnisync_checkpoint_failures_total", { kind: "upload" })).toBe(3);
    expect(sample(text, "omnisync_checkpoint_failures_total", { kind: "conflict" })).toBe(4);
    expect(sample(text, "omnisync_checkpoint_age_seconds")).toBe(42.5);
    expect(text).toContain("# TYPE omnisync_checkpoint_age_seconds gauge");
  });
  it("reports zero failures as zero, so an alert can tell absent from healthy", async () => {
    const { m, scrape } = setup();
    m.observeCheckpoints(cp());
    const text = await scrape();
    for (const kind of ["sign", "store", "upload", "conflict"]) expect(sample(text, "omnisync_checkpoint_failures_total", { kind })).toBe(0);
  });
  it("follows the age as it changes", async () => {
    const { m, scrape } = setup();
    const src = cp({}, 10);
    m.observeCheckpoints(src);
    expect(sample(await scrape(), "omnisync_checkpoint_age_seconds")).toBe(10);
    src.behind = 901;
    expect(sample(await scrape(), "omnisync_checkpoint_age_seconds")).toBe(901);
  });
});

describe("timings", () => {
  const bucketBounds = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
  it("records update apply time by outcome", async () => {
    const { m, scrape } = setup();
    m.updateFinished(0.004, "ok");
    m.updateFinished(0.3, "ok");
    m.updateFinished(0.002, "rejected");
    const text = await scrape();
    expect(text).toContain("# TYPE omnisync_update_apply_seconds histogram");
    expect(sample(text, "omnisync_update_apply_seconds_count", { outcome: "ok" })).toBe(2);
    expect(sample(text, "omnisync_update_apply_seconds_count", { outcome: "rejected" })).toBe(1);
    expect(sample(text, "omnisync_update_apply_seconds_sum", { outcome: "ok" })).toBeCloseTo(0.304, 6);
  });
  it("uses the documented bucket boundaries for every timing", async () => {
    const { m, scrape } = setup();
    m.updateFinished(0.01, "ok");
    m.ledgerAppend(0.01, "ok");
    m.fanout(0.01);
    const text = await scrape();
    for (const name of ["omnisync_update_apply_seconds", "omnisync_ledger_append_seconds", "omnisync_fanout_seconds"]) {
      const les = series(text, `${name}_bucket`).map((s) => s["le"]).filter((x): x is string => x !== undefined && x !== "+Inf");
      expect(les.map(Number).sort((a, b) => a - b)).toEqual(bucketBounds);
    }
  });
  it("puts a value in the right bucket", async () => {
    const { m, scrape } = setup();
    m.ledgerAppend(0.03, "ok"); // between 0.025 and 0.05
    const text = await scrape();
    const b = (le: string) => sample(text, "omnisync_ledger_append_seconds_bucket", { outcome: "ok", le });
    expect(b("0.025")).toBe(0);
    expect(b("0.05")).toBe(1);
    expect(b("+Inf")).toBe(1);
  });
  it("records ledger append and fan-out", async () => {
    const { m, scrape } = setup();
    m.ledgerAppend(0.02, "ok");
    m.ledgerAppend(0.5, "error");
    m.fanout(0.001);
    const text = await scrape();
    expect(sample(text, "omnisync_ledger_append_seconds_count", { outcome: "ok" })).toBe(1);
    expect(sample(text, "omnisync_ledger_append_seconds_count", { outcome: "error" })).toBe(1);
    expect(sample(text, "omnisync_fanout_seconds_count")).toBe(1);
  });
  it("never lets a bad outcome or value create a series or throw", async () => {
    const { m, scrape } = setup();
    m.updateFinished(0.01, "evil" as never);
    m.updateFinished(Number.NaN, "ok");
    m.updateFinished(-1, "ok");
    m.updateFinished(Infinity, "ok");
    const text = await scrape();
    expect(text).not.toContain("evil");
    expect(sample(text, "omnisync_update_apply_seconds_count", { outcome: "ok" }) ?? 0).toBe(0);
  });
});

describe("observer only", () => {
  const throwingMeter = new Proxy({}, { get: () => () => { throw new Error("meter broke"); } }) as never;
  it("a meter that throws on every call does not throw out of any method", () => {
    expect(() => {
      const m = new GatewayMetrics(throwingMeter);
      m.observe(source());
      m.observeCheckpoints({ stats: () => ({ uploaded: 0, signFailures: 0, storeFailures: 0, uploadFailures: 0, uploadConflicts: 0 }), behindSeconds: () => 0 });
      m.updateFinished(0.1, "ok");
      m.ledgerAppend(0.1, "ok");
      m.fanout(0.1);
    }).not.toThrow();
  });
  it("a source that throws at scrape time costs one scrape, not the process", async () => {
    const { m, scrape } = setup();
    m.observe({ ...source(), connections: () => { throw new Error("boom"); }, stats: () => { throw new Error("boom"); } });
    await expect(scrape()).resolves.toBeTypeOf("string");
  });
  it("the default meter is a working no-op", () => {
    const m = new GatewayMetrics();
    m.observe(source());
    m.updateFinished(0.1, "ok");
    m.ledgerAppend(0.1, "error");
    m.fanout(0.1);
  });
});

describe("hardening found by mutation checks", () => {
  function stubMeter() {
    const calls: { name: string; value: number; attrs: unknown }[] = [];
    const meter = {
      createHistogram: (name: string) => ({ record: (value: number, attrs?: unknown) => void calls.push({ name, value, attrs }) }),
      createCounter: (name: string) => ({ add: (value: number, attrs?: unknown) => void calls.push({ name, value, attrs }) }),
      createObservableGauge: () => ({ addCallback: () => {} }),
      createObservableCounter: () => ({ addCallback: () => {} }),
    };
    return { meter: meter as never, calls };
  }
  it("records a zero-second timing and refuses negative, NaN and infinite ones before they reach the instrument", () => {
    const { meter, calls } = stubMeter();
    const m = new GatewayMetrics(meter);
    for (const bad of [-1, Number.NaN, Infinity, -Infinity]) {
      m.updateFinished(bad, "ok");
      m.ledgerAppend(bad, "ok");
      m.fanout(bad);
    }
    expect(calls).toEqual([]);
    m.updateFinished(0, "ok");
    m.ledgerAppend(0, "ok");
    m.fanout(0);
    expect(calls.map((c) => c.name)).toEqual(["omnisync_update_apply_seconds", "omnisync_ledger_append_seconds", "omnisync_fanout_seconds"]);
  });
  it("reports a negative or non-finite gauge reading as zero", async () => {
    const { m, scrape } = setup();
    m.observe({ ...source(), connections: () => -3, documents: () => Number.NaN, appendQueueDepth: () => Infinity });
    const text = await scrape();
    expect(sample(text, "omnisync_connections_active")).toBe(0);
    expect(sample(text, "omnisync_documents_active")).toBe(0);
    expect(sample(text, "omnisync_append_queue_depth")).toBe(0);
  });
  it("reports negative and non-finite counters as zero", async () => {
    const { m, scrape } = setup();
    m.observe(source({ c: counters({ persisted: -4, duplicates: Number.NaN, authenticated: -1, authFailures: { x: -2, y: Number.NaN } }) }));
    const text = await scrape();
    expect(sample(text, "omnisync_updates_total", { outcome: "persisted" })).toBe(0);
    expect(sample(text, "omnisync_updates_total", { outcome: "duplicate" })).toBe(0);
    expect(sample(text, "omnisync_connections_total", { outcome: "ok" })).toBe(0);
    expect(sample(text, "omnisync_connections_total", { outcome: "failed" })).toBe(0);
  });
  it("binds to the first source only", async () => {
    const { m, scrape } = setup();
    m.observe(source({ connections: 1 }));
    m.observe(source({ connections: 99 }));
    expect(sample(await scrape(), "omnisync_connections_active")).toBe(1);
  });
  it("binds to the first checkpoint source only", async () => {
    const { m, scrape } = setup();
    const mk = (n: number): CheckpointSource => ({ stats: () => ({ uploaded: n, signFailures: 0, storeFailures: 0, uploadFailures: 0, uploadConflicts: 0 }), behindSeconds: () => n });
    m.observeCheckpoints(mk(1));
    m.observeCheckpoints(mk(99));
    expect(sample(await scrape(), "omnisync_checkpoints_total")).toBe(1);
  });
  it("a rejection bucket called busy cannot add to the busy count", async () => {
    const { m, scrape } = setup();
    m.observe(source({ c: counters({ busyRejections: 2, rejected: { busy: 50 } }) }));
    const text = await scrape();
    expect(sample(text, "omnisync_admission_rejections_total", { reason: "busy" })).toBe(2);
    expect(sample(text, "omnisync_admission_rejections_total", { reason: "other" })).toBe(50);
  });
  it("never lets an outcome outside the set into the append timing label", async () => {
    const { m, scrape } = setup();
    m.ledgerAppend(0.01, "evil" as never);
    const text = await scrape();
    expect(text).not.toContain("evil");
    expect(sample(text, "omnisync_ledger_append_seconds_count", { outcome: "other" })).toBe(1);
  });
});
