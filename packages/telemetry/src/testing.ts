import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { PrometheusExporter, PrometheusSerializer } from "@opentelemetry/exporter-prometheus";
import { SpanStatusCode, type Meter, type Tracer } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";

/** Test support (`@omnisync/telemetry/testing`): a real SDK whose output is read back as Prometheus text or finished spans. */

/** A real SDK meter whose output is read as Prometheus text, exactly what a scrape would return. */
export function testMeter(): { meter: Meter; scrape: () => Promise<string>; shutdown: () => Promise<void> } {
  const exporter = new PrometheusExporter({ preventServerStart: true });
  const provider = new MeterProvider({ readers: [exporter] });
  const serializer = new PrometheusSerializer("", false, undefined, true, true);
  return {
    meter: provider.getMeter("omnisync-test"),
    scrape: async () => serializer.serialize((await exporter.collect()).resourceMetrics),
    shutdown: () => provider.shutdown(),
  };
}

/** Value of one sample line, or undefined when the series does not exist. Labels must match exactly. */
export function sample(text: string, name: string, labels: Record<string, string> = {}): number | undefined {
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || !line.startsWith(name)) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line);
    if (!m || m[1] !== name) continue;
    const got: Record<string, string> = {};
    for (const part of (m[2] ?? "").matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) got[part[1] as string] = part[2] as string;
    const keys = Object.keys(labels);
    if (Object.keys(got).length === keys.length && keys.every((k) => got[k] === labels[k])) return Number(m[3]);
  }
  return undefined;
}

/** Every series of a metric: label sets only. */
export function series(text: string, name: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const line of text.split("\n")) {
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+\S+/.exec(line);
    if (line.startsWith("#") || !m || m[1] !== name) continue;
    const got: Record<string, string> = {};
    for (const part of (m[2] ?? "").matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) got[part[1] as string] = part[2] as string;
    out.push(got);
  }
  return out;
}

/** A real tracer that keeps finished spans in memory. */
export function testTracer(): { tracer: Tracer; spans: () => ReadableSpan[]; shutdown: () => Promise<void> } {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { tracer: provider.getTracer("omnisync-test"), spans: () => exporter.getFinishedSpans(), shutdown: () => provider.shutdown() };
}

/** Status code of a span that ended in error, for tests outside this package. */
export const SPAN_ERROR = SpanStatusCode.ERROR;
