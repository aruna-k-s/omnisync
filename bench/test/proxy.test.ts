import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PartitionProxy } from "../src/load/proxy.js";

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

async function echoServer(): Promise<number> {
  const s = net.createServer((c) => c.pipe(c));
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => s.close(() => r())));
  return (s.address() as net.AddressInfo).port;
}

const connect = (port: number) =>
  new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
    closers.push(() => void s.destroy());
  });

const roundTrip = (s: net.Socket, text: string) =>
  new Promise<string>((resolve, reject) => {
    s.once("data", (d) => resolve(d.toString()));
    s.once("error", reject);
    s.write(text);
  });

const closed = (s: net.Socket) => new Promise<void>((r) => (s.destroyed ? r() : s.once("close", () => r())));

async function setup() {
  const upstream = await echoServer();
  const proxy = new PartitionProxy({ host: "127.0.0.1", port: upstream });
  await proxy.listen();
  closers.push(() => proxy.close());
  return proxy;
}

describe("PartitionProxy", () => {
  it("forwards bytes both ways and counts connections", async () => {
    const proxy = await setup();
    const c = await connect(proxy.port);
    expect(await roundTrip(c, "hello")).toBe("hello");
    expect(proxy.accepted).toBe(1);
    expect(proxy.openConnections).toBe(1);
    expect(proxy.partitioned).toBe(false);
  });

  it("partition kills open connections and refuses new ones", async () => {
    const proxy = await setup();
    const c = await connect(proxy.port);
    expect(await roundTrip(c, "a")).toBe("a");
    proxy.partition();
    await closed(c);
    expect(proxy.partitioned).toBe(true);
    const d = await connect(proxy.port); // the TCP accept happens, then the proxy drops it
    await closed(d);
    expect(proxy.refused).toBe(1);
    expect(proxy.accepted).toBe(1);
    expect(proxy.openConnections).toBe(0);
  });

  it("heal accepts again", async () => {
    const proxy = await setup();
    proxy.partition();
    proxy.heal();
    const c = await connect(proxy.port);
    expect(await roundTrip(c, "again")).toBe("again");
    expect(proxy.partitioned).toBe(false);
    expect(proxy.accepted).toBe(1);
    expect(proxy.refused).toBe(0);
  });

  it("closing the client side closes the upstream side", async () => {
    const proxy = await setup();
    const c = await connect(proxy.port);
    await roundTrip(c, "x");
    c.destroy();
    for (let i = 0; i < 50 && proxy.openConnections > 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(proxy.openConnections).toBe(0);
  });
});
