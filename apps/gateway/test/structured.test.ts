import { afterEach, describe, expect, it } from "vitest";
import type { EngineName } from "@omnisync/engine";
import { type GatewayClient } from "../src/index.js";
import { connectClient, makeWorld, until, startGateway, type Running, type World } from "./harness.js";

const engines: EngineName[] = ["yjs", "automerge", "loro"];

describe.each(engines)("structured data through the gateway (%s)", (engine) => {
  let world: World;
  const running: Running[] = [];
  const clients: GatewayClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    for (const r of running.splice(0)) await r.gateway.close().catch(() => {});
    await world?.cleanup();
  });
  const start = async () => {
    const r = await startGateway(world, { engine });
    running.push(r);
    return r;
  };
  const connect = async (r: Running, actor: number) => {
    const c = await connectClient(r.url, actor, engine);
    clients.push(c);
    return c;
  };

  it("two clients edit maps, arrays and text; a cold load rebuilds all of it", async () => {
    world = await makeWorld("memory");
    const g1 = await start();
    const a = await connect(g1, 1);
    const b = await connect(g1, 2);
    await a.mapSet([], "sheet", { title: "Q3", rows: [] });
    await until(() => JSON.stringify(b.doc.getData()).includes("Q3"), 3000, "b sees the sheet");
    await a.arrayInsert(["sheet", "rows"], 0, [{ item: "widgets", qty: 3 }]);
    await b.arrayInsert(["sheet", "rows"], 0, [{ item: "gadgets", qty: 5 }]);
    await a.insert(0, "notes");
    await until(() => (a.doc.getData() as { sheet: { rows: unknown[] } }).sheet.rows.length === 2 && (b.doc.getData() as { sheet: { rows: unknown[] } }).sheet.rows.length === 2, 3000, "both rows");
    await a.mapSet(["sheet"], "title", "Q4");
    await b.mapDelete(["sheet", "rows", 0], "qty");
    await until(() => JSON.stringify(sortKeys(a.doc.getData())) === JSON.stringify(sortKeys(b.doc.getData())) && JSON.stringify(a.doc.getData()).includes("Q4"), 3000, "converged");
    expect(a.unacked + b.unacked).toBe(0);
    const expected = a.doc.getData();
    const expectedText = a.doc.getText();
    await a.close();
    await b.close();
    await g1.gateway.close();

    const g2 = await start(); // same store: the room loads from the durable log
    const c = await connect(g2, 3);
    expect(JSON.stringify(sortKeys(c.doc.getData()))).toBe(JSON.stringify(sortKeys(expected)));
    expect(c.doc.getText()).toBe(expectedText);
  });

  it("a bad structured edit never leaves the client: nothing is signed or stored", async () => {
    world = await makeWorld("memory");
    const g = await start();
    const a = await connect(g, 1);
    expect(() => a.mapSet(["missing"], "k", 1)).toThrow(RangeError);
    expect(() => a.mapSet([], "k", undefined as never)).toThrow(RangeError);
    expect(await world.rawStore.headSeq("doc")).toBe(0);
    expect(a.unacked).toBe(0);
  });
});

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}
