import { metrics, trace, type Meter, type Tracer } from "@opentelemetry/api";

/**
 * Telemetry configuration (spec: docs/specs/observability.md). Off unless asked; the SDK and exporters are loaded by
 * dynamic import only when something is enabled, so a deployment that sets nothing pays nothing.
 */
export interface TelemetryConfig {
  readonly metrics?: { readonly port: number; readonly host: string };
  readonly traces?: { readonly endpoint: string; readonly sampleRatio: number };
}

export interface Telemetry {
  /** Pass to `GatewayMetrics` / `ControlPlaneMetrics`. A no-op meter when metrics are off. */
  readonly meter: Meter;
  /** Pass to `Tracing`. A non-recording tracer when traces are off. */
  readonly tracer: Tracer;
  /** The port `/metrics` is served on; undefined when off or when it could not be opened. */
  readonly metricsPort: number | undefined;
  /** Flushes spans and stops the listener. Safe to call twice; never throws. */
  shutdown(): Promise<void>;
}

type Log = (event: string, fields?: Record<string, unknown>) => void;

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_RATIO = 0.01;
const SHUTDOWN_CAP_MS = 3000;

function refuse(name: string, why: string): never {
  throw new Error(`${name} ${why}`);
}

/** Reads the settings and refuses anything unclear. Error messages name the variable and never echo a value. */
export function parseTelemetryConfig(env: Readonly<Record<string, string | undefined>>, opts: { appPort: number }): TelemetryConfig {
  const out: { metrics?: { port: number; host: string }; traces?: { endpoint: string; sampleRatio: number } } = {};

  const portRaw = env["OMNISYNC_METRICS_PORT"];
  const hostRaw = env["OMNISYNC_METRICS_HOST"];
  if (portRaw !== undefined) {
    if (!/^[0-9]{1,5}$/.test(portRaw)) refuse("OMNISYNC_METRICS_PORT", "must be a whole number between 1024 and 65535");
    const port = Number(portRaw);
    if (port < 1024 || port > 65535) refuse("OMNISYNC_METRICS_PORT", "must be a whole number between 1024 and 65535");
    if (port === opts.appPort) refuse("OMNISYNC_METRICS_PORT", "must differ from the application port: /metrics is never served there");
    if (hostRaw !== undefined && !/^[A-Za-z0-9.:-]{1,253}$/.test(hostRaw)) refuse("OMNISYNC_METRICS_HOST", "must be an address or host name");
    out.metrics = { port, host: hostRaw ?? DEFAULT_HOST };
  } else if (hostRaw !== undefined) {
    refuse("OMNISYNC_METRICS_HOST", "is set without OMNISYNC_METRICS_PORT");
  }

  const switchRaw = env["OMNISYNC_TRACES_ENABLED"];
  const ratioRaw = env["OMNISYNC_TRACE_SAMPLE_RATIO"];
  if (switchRaw !== undefined && switchRaw !== "0" && switchRaw !== "1") refuse("OMNISYNC_TRACES_ENABLED", 'must be exactly "1" (on) or "0" (off)');
  if (switchRaw !== "1") {
    if (ratioRaw !== undefined) refuse("OMNISYNC_TRACE_SAMPLE_RATIO", "is set while OMNISYNC_TRACES_ENABLED is not 1");
    return out;
  }
  const endpoint = env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  if (endpoint === undefined) refuse("OTEL_EXPORTER_OTLP_ENDPOINT", "is required when OMNISYNC_TRACES_ENABLED=1");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    refuse("OTEL_EXPORTER_OTLP_ENDPOINT", "must be an http or https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") refuse("OTEL_EXPORTER_OTLP_ENDPOINT", "must be an http or https URL");
  if (url.username !== "" || url.password !== "") refuse("OTEL_EXPORTER_OTLP_ENDPOINT", "must not contain credentials; use OTEL_EXPORTER_OTLP_HEADERS");
  let sampleRatio = DEFAULT_RATIO;
  if (ratioRaw !== undefined) {
    if (!/^(?:0|1|0?\.[0-9]+|0\.[0-9]+|1\.0+)$/.test(ratioRaw)) refuse("OMNISYNC_TRACE_SAMPLE_RATIO", "must be a number from 0 to 1");
    sampleRatio = Number(ratioRaw);
    if (!(sampleRatio >= 0 && sampleRatio <= 1)) refuse("OMNISYNC_TRACE_SAMPLE_RATIO", "must be a number from 0 to 1");
  }
  out.traces = { endpoint, sampleRatio };
  return out;
}

/**
 * Starts what the configuration asks for. A listener that cannot open (the port is taken) or an exporter that cannot
 * be built is logged and skipped: telemetry never stops the service it observes.
 */
export async function setupTelemetry(cfg: TelemetryConfig, opts: { service: string; log?: Log }): Promise<Telemetry> {
  const log: Log = opts.log ?? (() => {});
  let meter: Meter = metrics.getMeter("omnisync");
  let tracer: Tracer = trace.getTracer("omnisync");
  let metricsPort: number | undefined;
  const stops: (() => Promise<void>)[] = [];

  if (cfg.metrics || cfg.traces) {
    try {
      const { resourceFromAttributes } = await import("@opentelemetry/resources");
      const resource = resourceFromAttributes({ "service.name": opts.service });

      if (cfg.metrics) {
        try {
          const { MeterProvider } = await import("@opentelemetry/sdk-metrics");
          const { PrometheusExporter } = await import("@opentelemetry/exporter-prometheus");
          const exporter = new PrometheusExporter({
            port: cfg.metrics.port,
            host: cfg.metrics.host,
            endpoint: "/metrics",
            withoutScopeInfo: true,
            preventServerStart: true,
          });
          await exporter.startServer();
          const provider = new MeterProvider({ resource, readers: [exporter] });
          meter = provider.getMeter("omnisync");
          metricsPort = cfg.metrics.port;
          stops.push(() => provider.shutdown());
        } catch (e) {
          log("metrics_unavailable", { port: cfg.metrics.port, error: (e as Error).message });
        }
      }

      if (cfg.traces) {
        try {
          const { BasicTracerProvider, BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } = await import("@opentelemetry/sdk-trace-base");
          const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
          const exporter = new OTLPTraceExporter({ url: `${cfg.traces.endpoint.replace(/\/+$/, "")}/v1/traces`, timeoutMillis: 2000 });
          const provider = new BasicTracerProvider({
            resource,
            sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(cfg.traces.sampleRatio) }),
            spanProcessors: [new BatchSpanProcessor(exporter)],
          });
          tracer = provider.getTracer("omnisync");
          stops.push(() => provider.shutdown());
        } catch (e) {
          log("traces_unavailable", { error: (e as Error).message });
        }
      }
    } catch (e) {
      log("telemetry_unavailable", { error: (e as Error).message });
    }
  }

  let stopped: Promise<void> | undefined;
  return {
    meter,
    tracer,
    metricsPort,
    shutdown: () => {
      stopped ??= (async () => {
        let timer: NodeJS.Timeout | undefined;
        const cap = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, SHUTDOWN_CAP_MS);
        });
        await Promise.race([Promise.allSettled(stops.map((s) => s())).then(() => undefined), cap]);
        clearTimeout(timer);
      })();
      return stopped;
    },
  };
}
