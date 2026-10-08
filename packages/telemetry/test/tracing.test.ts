import { describe, expect, it } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, ParentBasedSampler, SimpleSpanProcessor, TraceIdRatioBasedSampler, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { Tracing } from "../src/tracing.js";

function setup(ratio = 1) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { tracing: new Tracing(provider.getTracer("test")), spans: () => exporter.getFinishedSpans() };
}
const byName = (spans: ReadableSpan[], name: string) => spans.find((s) => s.name === name);
const ALLOWED = new Set(["omnisync.update.bytes", "omnisync.outcome", "omnisync.batch", "omnisync.checkpoint.n", "omnisync.checkpoint.documents"]);

describe("edit trace", () => {
  it("makes a root with verify, append and fanout children", () => {
    const { tracing, spans } = setup();
    const t = tracing.edit(120);
    t.stage("verify")();
    const endAppend = t.stage("append");
    endAppend();
    t.stage("fanout")();
    t.end("ok");
    const all = spans();
    expect(all.map((s) => s.name).sort()).toEqual(["append", "fanout", "omnisync.edit", "verify"]);
    const root = byName(all, "omnisync.edit") as ReadableSpan;
    for (const child of ["verify", "append", "fanout"]) {
      const s = byName(all, child) as ReadableSpan;
      expect(s.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
      expect(s.spanContext().traceId).toBe(root.spanContext().traceId);
    }
    expect(root.attributes["omnisync.update.bytes"]).toBe(120);
    expect(root.attributes["omnisync.outcome"]).toBe("ok");
  });
  it("only ever carries allowlisted attributes with plain values", () => {
    const { tracing, spans } = setup();
    const t = tracing.edit(5);
    t.stage("verify")();
    t.end("bad_signature");
    for (const s of spans()) {
      for (const [k, v] of Object.entries(s.attributes)) {
        expect(ALLOWED.has(k)).toBe(true);
        expect(["number", "string"]).toContain(typeof v);
      }
    }
  });
  it("replaces an outcome outside the closed set", () => {
    const { tracing, spans } = setup();
    const t = tracing.edit(5);
    t.end("secret-token-abc123 for user@example.com");
    const root = byName(spans(), "omnisync.edit") as ReadableSpan;
    expect(root.attributes["omnisync.outcome"]).toBe("other");
    expect(JSON.stringify(spans().map((s) => s.attributes))).not.toContain("secret");
  });
  it("folds the claimed-time reasons into one outcome", () => {
    for (const reason of ["claimed_before_validity", "claimed_after_expiry", "claimed_in_future"]) {
      const { tracing, spans } = setup();
      tracing.edit(1).end(reason);
      expect((byName(spans(), "omnisync.edit") as ReadableSpan).attributes["omnisync.outcome"]).toBe("claimed_time");
    }
  });
  it("marks server-side failures as errors and refusals as not", () => {
    const a = setup();
    a.tracing.edit(1).end("unavailable", true);
    expect((byName(a.spans(), "omnisync.edit") as ReadableSpan).status.code).toBe(SpanStatusCode.ERROR);
    const b = setup();
    b.tracing.edit(1).end("bad_signature");
    expect((byName(b.spans(), "omnisync.edit") as ReadableSpan).status.code).not.toBe(SpanStatusCode.ERROR);
  });
  it("end is idempotent and ends open stages", () => {
    const { tracing, spans } = setup();
    const t = tracing.edit(1);
    t.stage("append"); // never ended by the caller
    t.end("ok");
    t.end("ok");
    expect(spans().map((s) => s.name).sort()).toEqual(["append", "omnisync.edit"]);
  });
  it("a stage ended twice is recorded once", () => {
    const { tracing, spans } = setup();
    const t = tracing.edit(1);
    const end = t.stage("verify");
    end();
    end();
    t.end("ok");
    expect(spans().filter((s) => s.name === "verify")).toHaveLength(1);
  });
  it("ratio 0 records nothing and still works", () => {
    const { tracing, spans } = setup(0);
    const t = tracing.edit(1);
    t.stage("verify")();
    t.end("ok");
    expect(spans()).toHaveLength(0);
  });
  it("the default tracer is a working no-op", () => {
    const t = new Tracing().edit(1);
    t.stage("verify")();
    t.end("ok");
  });
  it("a tracer that throws on every call does not throw out", () => {
    const throwing = new Proxy({}, { get: () => () => { throw new Error("tracer broke"); } }) as never;
    expect(() => {
      const t = new Tracing(throwing).edit(1);
      t.stage("verify")();
      t.end("ok", true);
      new Tracing(throwing).checkpoint().end("ok");
    }).not.toThrow();
  });
});

describe("checkpoint trace", () => {
  it("is its own root with checkpoint number and document count", () => {
    const { tracing, spans } = setup();
    const c = tracing.checkpoint();
    c.set({ n: 7, documents: 3 });
    c.end("ok");
    const [s] = spans();
    expect(spans()).toHaveLength(1);
    expect(s?.name).toBe("omnisync.checkpoint");
    expect(s?.parentSpanContext).toBeUndefined();
    expect(s?.attributes["omnisync.checkpoint.n"]).toBe(7);
    expect(s?.attributes["omnisync.checkpoint.documents"]).toBe(3);
  });
  it("drops non-integer or negative numbers", () => {
    const { tracing, spans } = setup();
    const c = tracing.checkpoint();
    c.set({ n: -1, documents: 1.5 });
    c.end("ok");
    expect(spans()[0]?.attributes).toEqual({ "omnisync.outcome": "ok" });
  });
});

describe("span bookkeeping (against a recording tracer)", () => {
  function stub() {
    const log: string[] = [];
    const tracer = {
      startSpan: (name: string) => {
        log.push(`start ${name}`);
        const span = {
          setAttribute: (k: string, v: unknown) => (log.push(`attr ${name} ${k}=${String(v)}`), span),
          setStatus: () => (log.push(`status ${name}`), span),
          end: () => void log.push(`end ${name}`),
        };
        return span;
      },
    };
    return { tracer: tracer as never, log };
  }
  it("ends the edit once however often end is called, and ignores later stages", () => {
    const { tracer, log } = stub();
    const t = new Tracing(tracer).edit(10);
    t.end("ok");
    t.end("bad_signature", true);
    t.stage("verify")();
    expect(log.filter((l) => l === "end omnisync.edit")).toHaveLength(1);
    expect(log.filter((l) => l.startsWith("status"))).toHaveLength(0);
    expect(log.filter((l) => l.startsWith("start verify"))).toHaveLength(0);
  });
  it("ends a stage once however often it is ended", () => {
    const { tracer, log } = stub();
    const t = new Tracing(tracer).edit(10);
    const end = t.stage("fanout");
    end();
    end();
    t.end("ok");
    expect(log.filter((l) => l === "end fanout")).toHaveLength(1);
  });
  it("ends stages left open when the edit ends", () => {
    const { tracer, log } = stub();
    const t = new Tracing(tracer).edit(10);
    t.stage("append");
    t.end("ok");
    expect(log).toContain("end append");
    expect(log.indexOf("end append")).toBeLessThan(log.indexOf("end omnisync.edit"));
  });
  it("sets the byte count only for a plausible size", () => {
    for (const bad of [-1, 1.5, Number.NaN, Infinity, "5" as never]) {
      const { tracer, log } = stub();
      new Tracing(tracer).edit(bad);
      expect(log.filter((l) => l.includes("omnisync.update.bytes")), String(bad)).toEqual([]);
    }
    const { tracer, log } = stub();
    new Tracing(tracer).edit(0);
    expect(log).toContain("attr omnisync.edit omnisync.update.bytes=0");
  });
  it("names a stage from the closed set only", () => {
    const { tracer, log } = stub();
    const t = new Tracing(tracer).edit(1);
    t.stage("user@example.com" as never)();
    t.stage("verify")();
    expect(log).toContain("start other");
    expect(log).toContain("start verify");
    expect(log.join("\n")).not.toContain("example.com");
  });
  it("ignores attributes set on a checkpoint after it ended", () => {
    const { tracer, log } = stub();
    const c = new Tracing(tracer).checkpoint();
    c.end("ok");
    c.set({ n: 9, documents: 9 });
    expect(log.filter((l) => l.includes("omnisync.checkpoint.n"))).toEqual([]);
    c.end("unavailable", true);
    expect(log.filter((l) => l === "end omnisync.checkpoint")).toHaveLength(1);
  });
  it("accepts zero and rejects fractions, negatives and other types as checkpoint numbers", () => {
    const { tracer, log } = stub();
    const c = new Tracing(tracer).checkpoint();
    c.set({ n: 0, documents: 0 });
    c.set({ n: 1.5, documents: -1 });
    c.set({ n: "7" as never, documents: Number.NaN });
    expect(log.filter((l) => l.startsWith("attr"))).toEqual(["attr omnisync.checkpoint omnisync.checkpoint.n=0", "attr omnisync.checkpoint omnisync.checkpoint.documents=0"]);
  });
});
