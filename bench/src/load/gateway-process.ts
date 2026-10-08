import { fork, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";

/** The parent's view of the gateway child process (gateway-child.ts). */

export interface StartOptions {
  engine: string;
  /** Hex public keys the gateway accepts (static-key mode, like the existing bench). */
  publicKeys: string[];
  store: { kind: "memory" } | { kind: "postgres"; url: string; schema: string };
  /** Snapshots go to the file system, not memory, so they do not count as gateway memory. */
  objectsDir: string;
  /** Fixed port, to restart on the same one. */
  port?: number;
  metricsPort: number;
  compactEveryUpdates?: number;
  maxPayloadBytes?: number;
  idleEvictMs?: number;
  sweepMs?: number;
}

export type ChildCommand =
  | { t: "start"; options: StartOptions }
  | { t: "mem"; id: number }
  | { t: "stats"; id: number }
  | { t: "stop" };

export type ChildReply =
  | { t: "spawned" }
  | { t: "ready"; port: number; metricsPort: number | undefined; pid: number }
  | { t: "mem"; id: number; rss: number; heapUsed: number; external: number; arrayBuffers: number }
  | { t: "stats"; id: number; stats: Record<string, unknown> }
  | { t: "log"; event: string; fields: Record<string, unknown>; at: number }
  | { t: "error"; message: string }
  | { t: "stopped" };

export interface MemoryReading {
  rss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export class GatewayProcess {
  readonly logs: { event: string; fields: Record<string, unknown>; at: number }[] = [];
  port = 0;
  metricsPort = 0;
  pid = 0;
  readonly #child: ChildProcess;
  readonly #waiters = new Map<number, (m: ChildReply) => void>();
  #seq = 0;
  #exited: Promise<void>;
  #onReady: ((m: Extract<ChildReply, { t: "ready" }>) => void) | undefined;
  #onFail: ((e: Error) => void) | undefined;

  private constructor() {
    this.#child = fork(new URL("./gateway-child.ts", import.meta.url), [], { execArgv: ["--expose-gc", "--import", "tsx"], stdio: ["ignore", "inherit", "inherit", "ipc"] });
    this.#exited = new Promise((resolve) => this.#child.once("exit", () => resolve()));
    this.#child.on("exit", (code) => this.#onFail?.(new Error(`gateway process exited with code ${code}`)));
    this.#child.on("message", (m: ChildReply) => {
      if (m.t === "ready") this.#onReady?.(m);
      else if (m.t === "error") this.#onFail?.(new Error(m.message));
      else if (m.t === "log") this.logs.push({ event: m.event, fields: m.fields, at: m.at });
      else if ((m.t === "mem" || m.t === "stats") && this.#waiters.has(m.id)) {
        this.#waiters.get(m.id)?.(m);
        this.#waiters.delete(m.id);
      }
    });
  }

  /** Starts a gateway process and resolves when it is listening. */
  static async start(options: Omit<StartOptions, "metricsPort"> & { metricsPort?: number }): Promise<GatewayProcess> {
    const p = new GatewayProcess();
    const metricsPort = options.metricsPort ?? (await freePort());
    await new Promise<void>((resolve, reject) => {
      p.#onFail = reject;
      p.#onReady = (m) => {
        p.port = m.port;
        p.metricsPort = m.metricsPort ?? 0;
        p.pid = m.pid;
        p.#onFail = undefined;
        resolve();
      };
      p.#child.send({ t: "start", options: { ...options, metricsPort } } satisfies ChildCommand);
    });
    return p;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  #ask<T extends ChildReply>(make: (id: number) => ChildCommand): Promise<T> {
    const id = ++this.#seq;
    return new Promise((resolve) => {
      this.#waiters.set(id, (m) => resolve(m as T));
      this.#child.send(make(id));
    });
  }

  /** Resident memory of the gateway process after two forced garbage collections. */
  async memory(): Promise<MemoryReading> {
    const m = await this.#ask<Extract<ChildReply, { t: "mem" }>>((id) => ({ t: "mem", id }));
    return { rss: m.rss, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers };
  }

  async stats(): Promise<Record<string, unknown>> {
    return (await this.#ask<Extract<ChildReply, { t: "stats" }>>((id) => ({ t: "stats", id }))).stats;
  }

  /** The text a Prometheus scrape of the gateway's own /metrics returns. */
  scrape(): Promise<string> {
    return new Promise((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port: this.metricsPort, path: "/metrics" }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks).toString()));
        })
        .on("error", reject);
    });
  }

  /** Graceful stop: the gateway drains, telemetry flushes, the store closes. */
  async stop(): Promise<void> {
    if (this.#child.exitCode === null) this.#child.send({ t: "stop" } satisfies ChildCommand);
    await Promise.race([this.#exited, new Promise<void>((r) => setTimeout(r, 10_000).unref())]);
    this.kill();
  }

  kill(): void {
    if (this.#child.exitCode === null) this.#child.kill("SIGKILL");
  }
}
