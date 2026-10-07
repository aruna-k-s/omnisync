import { describe, expect, it } from "vitest";
import { AdminApi, ApiError } from "../src/app/api.js";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function fake(responses: (call: Call) => { status?: number; json?: unknown; text?: string }): { api: AdminApi; calls: Call[]; setToken: (t: string | undefined) => void } {
  const calls: Call[] = [];
  let token: string | undefined = "tok";
  const fetcher = (async (input: unknown, init?: RequestInit) => {
    const call: Call = { url: String(input), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, ...(typeof init?.body === "string" ? { body: init.body } : {}) };
    calls.push(call);
    const r = responses(call);
    const status = r.status ?? 200;
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { api: new AdminApi("https://cp.example", () => token, fetcher), calls, setToken: (t) => void (token = t) };
}

describe("AdminApi", () => {
  it("sends the bearer token, and none when signed out", async () => {
    const { api, calls, setToken } = fake(() => ({ json: { id: "p", email: "e", displayName: "d", orgRole: "admin" } }));
    await api.me();
    expect(calls[0]?.headers["authorization"]).toBe("Bearer tok");
    expect(calls[0]?.headers["content-type"]).toBeUndefined();
    setToken(undefined);
    await api.me();
    expect(calls[1]?.headers["authorization"]).toBeUndefined();
  });

  it("follows next until the server stops sending it", async () => {
    const pages: Record<string, unknown> = {
      "": { principals: [{ id: "a" }, { id: "b" }], next: "b" },
      b: { principals: [{ id: "c" }, { id: "d" }], next: "d" },
      d: { principals: [{ id: "e" }] },
    };
    const { api, calls } = fake((c) => ({ json: pages[new URL(c.url).searchParams.get("after") ?? ""] }));
    expect((await api.people()).map((p) => p.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(calls.map((c) => c.url)).toEqual([
      "https://cp.example/v1/admin/principals?limit=200",
      "https://cp.example/v1/admin/principals?limit=200&after=b",
      "https://cp.example/v1/admin/principals?limit=200&after=d",
    ]);
  });

  it("stops a server that never ends a listing", async () => {
    const { api, calls } = fake(() => ({ json: { documents: [], next: "x" } }));
    await expect(api.documents()).rejects.toMatchObject({ status: 0 });
    expect(calls).toHaveLength(200);
  });

  it("reads the audit trail oldest-first from the server and shows newest first", async () => {
    const { api } = fake(() => ({ json: { events: [{ id: 1 }, { id: 2 }, { id: 3 }] } }));
    expect((await api.audit()).map((e) => e.id)).toEqual([3, 2, 1]);
  });

  it("turns error responses into ApiError with the server's message, or a generic one", async () => {
    const a = fake(() => ({ status: 409, json: { error: "a document needs at least one enabled admin" } }));
    await expect(a.api.removeGrant("d", "p")).rejects.toMatchObject({ name: "ApiError", status: 409, message: "a document needs at least one enabled admin" });
    const b = fake(() => ({ status: 502, text: "<html>bad gateway</html>" }));
    const e = await b.api.me().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 502, message: "request failed (502)" });
    const c = fake(() => ({ status: 400, json: { error: 5 } }));
    await expect(c.api.me()).rejects.toMatchObject({ message: "request failed (400)" });
  });

  it("encodes ids in paths and sends the right method and body", async () => {
    const { api, calls } = fake((c) => (c.url.endsWith("/disable") ? { json: { certificatesRevoked: 2 } } : { json: { ok: true } }));
    await api.setGrant("d/1", "p 2", "merge");
    await api.removeGrant("d/1", "p 2");
    await api.revoke("ab12", "lost");
    expect(await api.disable("p/3")).toBe(2);
    await api.certificates("p?x");
    await api.grants("d#1");
    expect(calls.map((c) => `${c.method} ${c.url.replace("https://cp.example", "")}`)).toEqual([
      "PUT /v1/admin/documents/d%2F1/grants/p%202",
      "DELETE /v1/admin/documents/d%2F1/grants/p%202",
      "POST /v1/certificates/ab12/revoke",
      "POST /v1/principals/p%2F3/disable",
      "GET /v1/admin/principals/p%3Fx/certificates",
      "GET /v1/admin/documents/d%231/grants",
    ]);
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ role: "merge" });
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(calls[1]?.body).toBeUndefined();
    expect(JSON.parse(calls[2]?.body ?? "")).toEqual({ reason: "lost" });
  });

  it("returns the export as text, untouched", async () => {
    const { api, calls } = fake(() => ({ text: '{"t":"meta"}\n{"t":"entry"}\n' }));
    expect(await api.exportText()).toBe('{"t":"meta"}\n{"t":"entry"}\n');
    expect(calls[0]?.url).toBe("https://cp.example/v1/admin/ledger/export");
  });
});
