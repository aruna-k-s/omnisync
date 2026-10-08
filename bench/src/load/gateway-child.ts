/**
 * The gateway as its own process for the load harness (spec: docs/specs/load.md, rule 5): the real `Gateway` class, a
 * real store, the real 10a telemetry on its own port. Controlled over IPC by `GatewayProcess` (gateway-process.ts).
 */
import { Gateway } from "@omnisync/gateway";
import { Keyring } from "@omnisync/protocol";
import { FsObjectStore, MemoryDocumentStore, PgDocumentStore, migrate, type DocumentStore } from "@omnisync/store";
import { GatewayMetrics, parseTelemetryConfig, setupTelemetry } from "@omnisync/telemetry";
import type { EngineName } from "@omnisync/engine";
import type { ChildCommand, ChildReply, StartOptions } from "./gateway-process.js";

const send = (m: ChildReply): void => void process.send?.(m);
const gc = (): void => (globalThis as { gc?: () => void }).gc?.();

let gateway: Gateway | undefined;
let store: (DocumentStore & { close?: () => Promise<void> }) | undefined;
let telemetry: Awaited<ReturnType<typeof setupTelemetry>> | undefined;

async function start(o: StartOptions): Promise<void> {
  const ring = new Keyring();
  for (const k of o.publicKeys) ring.add(Uint8Array.from(Buffer.from(k, "hex")));
  if (o.store.kind === "postgres") {
    const pgStore = new PgDocumentStore({ connectionString: o.store.url, schema: o.store.schema });
    await migrate(pgStore.pool);
    store = pgStore;
  } else {
    store = new MemoryDocumentStore();
  }
  const log = (event: string, fields?: Record<string, unknown>): void => {
    if (event === "room_loaded" || event === "snapshot_written" || event === "snapshot_failed" || event === "metrics_unavailable") send({ t: "log", event, fields: fields ?? {}, at: Date.now() });
  };
  const config = parseTelemetryConfig({ OMNISYNC_METRICS_PORT: String(o.metricsPort) }, { appPort: o.port ?? 0 });
  telemetry = await setupTelemetry(config, { service: "omnisync-gateway-load", log });
  const metrics = new GatewayMetrics(telemetry.meter);
  gateway = new Gateway({
    engine: o.engine as EngineName,
    port: o.port ?? 0,
    host: "127.0.0.1",
    resolveKey: ring.resolve,
    store,
    objects: new FsObjectStore(o.objectsDir),
    log,
    metrics,
    ...(o.compactEveryUpdates !== undefined ? { compactEveryUpdates: o.compactEveryUpdates } : {}),
    ...(o.idleEvictMs !== undefined ? { idleEvictMs: o.idleEvictMs } : {}),
    ...(o.sweepMs !== undefined ? { sweepMs: o.sweepMs } : {}),
    ...(o.maxPayloadBytes !== undefined ? { maxPayloadBytes: o.maxPayloadBytes } : {}),
  });
  const port = await gateway.listen();
  send({ t: "ready", port, metricsPort: telemetry.metricsPort, pid: process.pid });
}

process.on("message", (m: ChildCommand) => {
  void (async () => {
    try {
      if (m.t === "start") await start(m.options);
      else if (m.t === "mem") {
        gc();
        gc();
        const u = process.memoryUsage();
        send({ t: "mem", id: m.id, rss: u.rss, heapUsed: u.heapUsed, external: u.external, arrayBuffers: u.arrayBuffers });
      } else if (m.t === "stats") send({ t: "stats", id: m.id, stats: JSON.parse(JSON.stringify(gateway?.stats ?? {})) });
      else if (m.t === "stop") {
        await gateway?.close();
        await telemetry?.shutdown();
        await store?.close?.();
        send({ t: "stopped" });
        process.exit(0);
      }
    } catch (e) {
      send({ t: "error", message: (e as Error).message });
    }
  })();
});
send({ t: "spawned" });
