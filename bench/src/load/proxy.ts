import net from "node:net";

/**
 * A TCP proxy that can be partitioned: `partition()` destroys every open connection and refuses new ones until
 * `heal()`. Clients see what a network partition looks like from their side, a dead socket and connection failures,
 * while the gateway keeps running. Used by the reconnect-storm scenario (spec: docs/specs/load.md).
 */
export class PartitionProxy {
  readonly #server: net.Server;
  readonly #open = new Set<net.Socket>();
  #partitioned = false;
  #accepted = 0;
  #refused = 0;
  #target: { host: string; port: number };

  constructor(target: { host: string; port: number }) {
    this.#target = target;
    this.#server = net.createServer((client) => this.#onClient(client));
  }

  get port(): number {
    return (this.#server.address() as net.AddressInfo).port;
  }
  get partitioned(): boolean {
    return this.#partitioned;
  }
  get openConnections(): number {
    return this.#open.size / 2; // client side and upstream side of each pair
  }
  get accepted(): number {
    return this.#accepted;
  }
  get refused(): number {
    return this.#refused;
  }

  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(port, "127.0.0.1", () => resolve(this.port));
    });
  }

  partition(): void {
    this.#partitioned = true;
    for (const s of [...this.#open]) s.destroy();
  }

  heal(): void {
    this.#partitioned = false;
  }

  async close(): Promise<void> {
    this.partition();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #onClient(client: net.Socket): void {
    if (this.#partitioned) {
      this.#refused++;
      client.destroy();
      return;
    }
    this.#accepted++;
    const upstream = net.connect(this.#target.port, this.#target.host);
    for (const s of [client, upstream]) {
      this.#open.add(s);
      s.setNoDelay(true);
      s.on("error", () => {});
      s.on("close", () => {
        this.#open.delete(s);
        (s === client ? upstream : client).destroy();
      });
    }
    client.pipe(upstream);
    upstream.pipe(client);
  }
}
