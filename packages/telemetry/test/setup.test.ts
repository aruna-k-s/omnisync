import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as netServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseTelemetryConfig, setupTelemetry, type Telemetry } from "../src/setup.js";

const parse = (env: Record<string, string>, appPort = 8080) => parseTelemetryConfig(env, { appPort });

describe("parseTelemetryConfig", () => {
  it("is off by default", () => {
    expect(parse({})).toEqual({});
  });
  it("reads the metrics endpoint with a loopback default", () => {
    expect(parse({ OMNISYNC_METRICS_PORT: "9464" })).toEqual({ metrics: { port: 9464, host: "127.0.0.1" } });
    expect(parse({ OMNISYNC_METRICS_PORT: "9464", OMNISYNC_METRICS_HOST: "0.0.0.0" })).toEqual({ metrics: { port: 9464, host: "0.0.0.0" } });
  });
  it.each(["", " ", "0", "1023", "65536", "-1", "9464.5", "abc", "9464 ", "0x2410", "1e4", "+9464"])("refuses metrics port %j", (v) => {
    expect(() => parse({ OMNISYNC_METRICS_PORT: v })).toThrow(/OMNISYNC_METRICS_PORT/);
  });
  it("refuses the application port", () => {
    expect(() => parse({ OMNISYNC_METRICS_PORT: "8080" }, 8080)).toThrow(/OMNISYNC_METRICS_PORT.*application port/);
    expect(parse({ OMNISYNC_METRICS_PORT: "8081" }, 8080).metrics?.port).toBe(8081);
  });
  it("refuses a host without a port, and an empty host", () => {
    expect(() => parse({ OMNISYNC_METRICS_HOST: "0.0.0.0" })).toThrow(/OMNISYNC_METRICS_HOST.*OMNISYNC_METRICS_PORT/);
    expect(() => parse({ OMNISYNC_METRICS_PORT: "9464", OMNISYNC_METRICS_HOST: "" })).toThrow(/OMNISYNC_METRICS_HOST/);
    expect(() => parse({ OMNISYNC_METRICS_PORT: "9464", OMNISYNC_METRICS_HOST: "bad host" })).toThrow(/OMNISYNC_METRICS_HOST/);
  });
  it("turns traces on only for the exact value 1", () => {
    const base = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" };
    expect(parse({ ...base, OMNISYNC_TRACES_ENABLED: "1" }).traces).toEqual({ endpoint: "http://collector:4318", sampleRatio: 0.01 });
    for (const v of ["true", "TRUE", "yes", "on", "2", " 1", "1 ", "01", ""]) {
      expect(() => parse({ ...base, OMNISYNC_TRACES_ENABLED: v })).toThrow(/OMNISYNC_TRACES_ENABLED/);
    }
    expect(parse({ ...base, OMNISYNC_TRACES_ENABLED: "0" }).traces).toBeUndefined();
  });
  it("requires an http(s) endpoint when traces are on", () => {
    expect(() => parse({ OMNISYNC_TRACES_ENABLED: "1" })).toThrow(/OTEL_EXPORTER_OTLP_ENDPOINT/);
    for (const v of ["collector:4318", "ftp://x", "file:///etc/passwd", "javascript:1", "not a url", ""]) {
      expect(() => parse({ OMNISYNC_TRACES_ENABLED: "1", OTEL_EXPORTER_OTLP_ENDPOINT: v })).toThrow(/OTEL_EXPORTER_OTLP_ENDPOINT/);
    }
    expect(parse({ OMNISYNC_TRACES_ENABLED: "1", OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com" }).traces?.endpoint).toBe("https://otel.example.com");
  });
  it("says the endpoint is required, not merely malformed", () => {
    expect(() => parse({ OMNISYNC_TRACES_ENABLED: "1" })).toThrow(/OTEL_EXPORTER_OTLP_ENDPOINT is required/);
  });
  it("refuses credentials in an http endpoint and points at the headers variable", () => {
    expect(() => parse({ OMNISYNC_TRACES_ENABLED: "1", OTEL_EXPORTER_OTLP_ENDPOINT: "http://user:pw@collector:4318" })).toThrow(/must not contain credentials.*OTEL_EXPORTER_OTLP_HEADERS/);
    expect(() => parse({ OMNISYNC_TRACES_ENABLED: "1", OTEL_EXPORTER_OTLP_ENDPOINT: "https://:pw@collector" })).toThrow(/credentials/);
    expect(() => parse({ OMNISYNC_TRACES_ENABLED: "1", OTEL_EXPORTER_OTLP_ENDPOINT: "https://user@collector" })).toThrow(/credentials/);
  });
  it("does not echo credentials from the endpoint in an error", () => {
    try {
      parse({ OMNISYNC_TRACES_ENABLED: "1", OTEL_EXPORTER_OTLP_ENDPOINT: "ftp://user:hunter2@host" });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("hunter2");
    }
  });
  it("reads and bounds the sample ratio", () => {
    const base = { OMNISYNC_TRACES_ENABLED: "1", OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" };
    expect(parse({ ...base, OMNISYNC_TRACE_SAMPLE_RATIO: "0" }).traces?.sampleRatio).toBe(0);
    expect(parse({ ...base, OMNISYNC_TRACE_SAMPLE_RATIO: "1" }).traces?.sampleRatio).toBe(1);
    expect(parse({ ...base, OMNISYNC_TRACE_SAMPLE_RATIO: "0.25" }).traces?.sampleRatio).toBe(0.25);
    for (const v of ["-0.1", "1.1", "abc", "", "NaN", "Infinity", "1e-1x", "0x1"]) {
      expect(() => parse({ ...base, OMNISYNC_TRACE_SAMPLE_RATIO: v })).toThrow(/OMNISYNC_TRACE_SAMPLE_RATIO/);
    }
  });
  it("refuses a sample ratio when traces are off", () => {
    expect(() => parse({ OMNISYNC_TRACE_SAMPLE_RATIO: "0.5" })).toThrow(/OMNISYNC_TRACE_SAMPLE_RATIO.*OMNISYNC_TRACES_ENABLED/);
  });
});

async function freePort(): Promise<number> {
  const s = netServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

let toClose: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(toClose.map((f) => f()));
  toClose = [];
});
async function start(cfg: Parameters<typeof setupTelemetry>[0], logs: string[] = []): Promise<Telemetry> {
  const t = await setupTelemetry(cfg, { service: "omnisync-test", log: (e, f) => logs.push(`${e} ${JSON.stringify(f ?? {})}`) });
  toClose.push(() => t.shutdown());
  return t;
}

describe("metrics endpoint", () => {
  it("serves /metrics with what the meter recorded, and 404 elsewhere", async () => {
    const port = await freePort();
    const t = await start({ metrics: { port, host: "127.0.0.1" } });
    expect(t.metricsPort).toBe(port);
    t.meter.createCounter("omnisync_probe").add(3);
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toMatch(/omnisync_probe_total 3/);
    for (const path of ["/", "/healthz", "/metrics/", "/metrics.json", "/admin"]) {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(r.status, path).toBe(404);
      await r.arrayBuffer();
    }
  });
  it("names the service in the exposed target info and nothing secret", async () => {
    const port = await freePort();
    const t = await start({ metrics: { port, host: "127.0.0.1" } });
    t.meter.createCounter("omnisync_probe").add(1);
    const text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    expect(text).toContain("omnisync-test");
    expect(text).not.toMatch(/DATABASE_URL|password|secret/i);
  });
  it("opens no listener when metrics are not configured", async () => {
    const t = await start({});
    expect(t.metricsPort).toBeUndefined();
    t.meter.createCounter("omnisync_probe").add(1); // no-op, must not throw
  });
  it("a port that is already taken is logged, not thrown", async () => {
    const port = await freePort();
    const squatter = netServer();
    await new Promise<void>((r) => squatter.listen(port, "127.0.0.1", r));
    toClose.push(() => new Promise<void>((r) => squatter.close(() => r())));
    const logs: string[] = [];
    const t = await start({ metrics: { port, host: "127.0.0.1" } }, logs);
    expect(t.metricsPort).toBeUndefined();
    expect(logs.join("\n")).toMatch(/metrics_unavailable/);
    t.meter.createCounter("omnisync_probe").add(1);
  });
  it("shutdown is one operation however often it is asked for", async () => {
    const t = await start({});
    expect(t.shutdown()).toBe(t.shutdown());
  });
  it("shutdown stops the listener and may be called twice", async () => {
    const port = await freePort();
    const t = await start({ metrics: { port, host: "127.0.0.1" } });
    await t.shutdown();
    await t.shutdown();
    await expect(fetch(`http://127.0.0.1:${port}/metrics`)).rejects.toThrow();
  });
});

describe("trace export", () => {
  it("sends sampled spans to the OTLP endpoint and not unsampled ones", async () => {
    const received: { url: string; type: string | undefined; bytes: number }[] = [];
    const collector: Server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received.push({ url: req.url ?? "", type: req.headers["content-type"], bytes: Buffer.concat(chunks).length });
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((r) => collector.listen(0, "127.0.0.1", r));
    toClose.push(() => new Promise<void>((r) => collector.close(() => r())));
    const endpoint = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;

    const on = await start({ traces: { endpoint, sampleRatio: 1 } });
    on.tracer.startSpan("probe").end();
    await on.shutdown();
    expect(received.length).toBeGreaterThan(0);
    expect(received[0]?.url).toBe("/v1/traces");
    expect(received[0]?.bytes).toBeGreaterThan(0);

    received.length = 0;
    const off = await start({ traces: { endpoint, sampleRatio: 0 } });
    for (let i = 0; i < 20; i++) off.tracer.startSpan("probe").end();
    await off.shutdown();
    expect(received).toHaveLength(0);
  });
  it("an unreachable collector does not throw at startup or shutdown", async () => {
    const t = await start({ traces: { endpoint: `http://127.0.0.1:${await freePort()}`, sampleRatio: 1 } });
    t.tracer.startSpan("probe").end();
    await expect(t.shutdown()).resolves.toBeUndefined();
  });
});

describe("source rules", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/setup.ts", import.meta.url)), "utf8");
  it("loads the SDK and exporters only by dynamic import", () => {
    expect(src).not.toMatch(/^import[^;]*from\s+["']@opentelemetry\/(sdk-|exporter-|resources)/m);
    expect(src).toMatch(/await import\(["']@opentelemetry\/exporter-prometheus["']\)/);
  });
});
