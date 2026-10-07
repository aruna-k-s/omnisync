import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryIdentityStore, type DeviceAuthInput } from "@omnisync/store";
import { startPlane, type Plane } from "./helpers.js";

const VERIFY = "http://localhost:4300/";
const alice = { sub: "alice-sub", email: "alice@example.com", name: "Alice" };
const bob = { sub: "bob-sub", email: "bob@example.com", name: "Bob" };
const CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;

interface Started {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresInS: number;
  intervalS: number;
}

describe("device-code login", () => {
  const planes: Plane[] = [];
  const make = async (over: Parameters<typeof startPlane>[0] = {}, store = new MemoryIdentityStore()) => {
    const p = await startPlane({ returnTo: [VERIFY], deviceLogin: { verificationUrl: VERIFY }, ...over }, store);
    planes.push(p);
    return p;
  };
  afterEach(async () => {
    await Promise.allSettled(planes.splice(0).map((p) => p.close()));
  });

  const start = async (p: Plane, body: unknown = { label: "build agent" }) => {
    const res = await p.call(undefined, "POST", "/v1/auth/device", body);
    return { res, body: res.json<Started>() };
  };
  const poll = (p: Plane, deviceCode: string) => p.call(undefined, "POST", "/v1/auth/device/token", { deviceCode });
  const code = (s: Started) => s.userCode.replace("-", "");

  it("starts a request: codes, URIs, lifetime and interval, never cached", async () => {
    const p = await make();
    const { res, body } = await start(p);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(body.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes
    expect(body.userCode).toMatch(CODE);
    expect(body.verificationUri).toBe(VERIFY);
    expect(body.verificationUriComplete).toBe(`${VERIFY}?device=${body.userCode}`);
    expect(body.expiresInS).toBe(600);
    expect(body.intervalS).toBe(5);
    const two = (await start(p)).body;
    expect(two.deviceCode).not.toBe(body.deviceCode);
    expect(two.userCode).not.toBe(body.userCode);
  });

  it("is off unless configured, and the verification URL must be an allowed return URL", async () => {
    const off = await startPlane({ returnTo: [VERIFY] });
    planes.push(off);
    expect((await start(off)).res.statusCode).toBe(404);
    expect(await off.call(undefined, "POST", "/v1/auth/device/token", { deviceCode: "x" })).toMatchObject({ statusCode: 404 });
    expect(await off.call(undefined, "GET", "/v1/auth/device/BCDFGHJK")).toMatchObject({ statusCode: 401 }); // the session guard answers first
    await expect(make({ returnTo: [], deviceLogin: { verificationUrl: VERIFY } })).rejects.toThrow(/returnTo/);
  });

  it("stores only the hash of the device code", async () => {
    const store = new MemoryIdentityStore();
    const seen: DeviceAuthInput[] = [];
    const orig = store.createDeviceAuth.bind(store);
    store.createDeviceAuth = (i, a) => (seen.push(i), orig(i, a));
    const p = await make({}, store);
    const { body } = await start(p);
    expect(seen).toHaveLength(1);
    expect(Buffer.from((seen[0] as DeviceAuthInput).deviceHash).toString("hex")).toBe(createHash("sha256").update(body.deviceCode).digest("hex"));
    expect(JSON.stringify(seen)).not.toContain(body.deviceCode);
    expect((seen[0] as DeviceAuthInput).userCode).toBe(code(body));
    expect((seen[0] as DeviceAuthInput).expiresAtMs - (seen[0] as DeviceAuthInput).atMs).toBe(600_000);
  });

  it("walks the whole flow: pending, approval by a signed-in person, one session token, then the token is gone", async () => {
    const p = await make();
    const { body } = await start(p);
    const pending = await poll(p, body.deviceCode);
    expect(pending.statusCode).toBe(400);
    expect(pending.json()).toEqual({ error: "authorization_pending" });

    const a = await p.login(alice);
    const look = await p.call(a.token, "GET", `/v1/auth/device/${body.userCode}`);
    expect(look.json()).toEqual({ label: "build agent", createdAtMs: p.clock.t, expiresAtMs: p.clock.t + 600_000, status: "pending" });
    expect((await p.call(a.token, "POST", `/v1/auth/device/${body.userCode}/approve`)).json()).toEqual({ approved: true });

    p.clock.advance(5000);
    const done = await poll(p, body.deviceCode);
    expect(done.statusCode).toBe(200);
    expect(done.headers["cache-control"]).toBe("no-store");
    const token = done.json<{ sessionToken: string }>().sessionToken;
    expect((await p.call(token, "GET", "/v1/me")).json()).toMatchObject({ id: a.id, email: "alice@example.com" });
    const claims = decodeJwt(token); // the same lifetime as a browser login: one hour
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(3600);

    p.clock.advance(5000);
    const again = await poll(p, body.deviceCode);
    expect(again.statusCode).toBe(400);
    expect(again.json()).toEqual({ error: "expired_token" });
  });

  it("accepts the user code in lower case and without the hyphen, and nothing else", async () => {
    const p = await make();
    const { body } = await start(p);
    const a = await p.login(alice);
    for (const form of [body.userCode.toLowerCase(), code(body), code(body).toLowerCase()]) {
      expect((await p.call(a.token, "GET", `/v1/auth/device/${form}`)).statusCode, form).toBe(200);
    }
    for (const bad of ["", "ABC", "BCDF-GHJ", `${code(body)}X`, "AEIOUAEI", "BCDF GHJK", "BCDF--GHJK", "bcdf_ghjk", "%00", "..%2F..%2Fme"]) {
      expect((await p.call(a.token, "GET", `/v1/auth/device/${bad}`)).statusCode, bad).toBe(404);
    }
  });

  it("every route that shows or decides a request needs a session; a disabled approver is refused", async () => {
    const p = await make({ adminEmails: ["root@example.com"] });
    const { body } = await start(p);
    for (const [m, u] of [["GET", ""], ["POST", "/approve"], ["POST", "/deny"]] as const) {
      expect((await p.call(undefined, m, `/v1/auth/device/${body.userCode}${u}`)).statusCode, u).toBe(401);
      expect((await p.call("garbage", m, `/v1/auth/device/${body.userCode}${u}`)).statusCode, u).toBe(401);
    }
    const a = await p.login(alice);
    const root = await p.login({ sub: "root", email: "root@example.com", name: "Root" });
    await p.call(root.token, "POST", `/v1/principals/${a.id}/disable`);
    expect((await p.call(a.token, "POST", `/v1/auth/device/${body.userCode}/approve`)).statusCode).toBe(401);
    expect((await poll(p, body.deviceCode)).json()).toEqual({ error: "authorization_pending" });
  });

  it("deny is reported once as access_denied, then the code is expired", async () => {
    const p = await make();
    const { body } = await start(p);
    const a = await p.login(alice);
    expect((await p.call(a.token, "POST", `/v1/auth/device/${body.userCode}/deny`)).json()).toEqual({ denied: true });
    expect((await poll(p, body.deviceCode)).json()).toEqual({ error: "access_denied" });
    p.clock.advance(5000);
    expect((await poll(p, body.deviceCode)).json()).toEqual({ error: "expired_token" });
  });

  it("the first decision stands: approve then deny, or deny then approve, is 409", async () => {
    const p = await make();
    const one = (await start(p)).body;
    const two = (await start(p)).body;
    const a = await p.login(alice);
    const b = await p.login(bob);
    expect((await p.call(a.token, "POST", `/v1/auth/device/${one.userCode}/approve`)).statusCode).toBe(200);
    expect((await p.call(b.token, "POST", `/v1/auth/device/${one.userCode}/deny`)).statusCode).toBe(409);
    expect((await p.call(a.token, "POST", `/v1/auth/device/${two.userCode}/deny`)).statusCode).toBe(200);
    expect((await p.call(b.token, "POST", `/v1/auth/device/${two.userCode}/approve`)).statusCode).toBe(409);
    // the device gets Alice, not Bob
    const done = await poll(p, one.deviceCode);
    expect((await p.call(done.json<{ sessionToken: string }>().sessionToken, "GET", "/v1/me")).json()).toMatchObject({ id: a.id });
  });

  it("a request expires: nothing to show, approve or poll after ten minutes", async () => {
    const p = await make();
    const { body } = await start(p);
    const a = await p.login(alice);
    p.clock.advance(599_999);
    expect((await p.call(a.token, "GET", `/v1/auth/device/${body.userCode}`)).statusCode).toBe(200);
    p.clock.advance(1);
    expect((await p.call(a.token, "GET", `/v1/auth/device/${body.userCode}`)).statusCode).toBe(404);
    expect((await p.call(a.token, "POST", `/v1/auth/device/${body.userCode}/approve`)).statusCode).toBe(404);
    expect((await poll(p, body.deviceCode)).json()).toEqual({ error: "expired_token" });
  });

  it("an approved person who is disabled before the device polls gets no session", async () => {
    const p = await make({ adminEmails: ["root@example.com"] });
    const { body } = await start(p);
    const a = await p.login(alice);
    const root = await p.login({ sub: "root", email: "root@example.com", name: "Root" });
    await p.call(a.token, "POST", `/v1/auth/device/${body.userCode}/approve`);
    await p.call(root.token, "POST", `/v1/principals/${a.id}/disable`);
    p.clock.advance(5000);
    const res = await poll(p, body.deviceCode);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "access_denied" });
    expect(JSON.stringify(res.json())).not.toContain("sessionToken");
  });

  it("unknown, malformed and wrong device codes are all just expired_token", async () => {
    const p = await make();
    await start(p);
    for (const bad of ["x", "", "a".repeat(43), "a".repeat(44), "../etc", 5, null, undefined, { a: 1 }]) {
      const res = await p.call(undefined, "POST", "/v1/auth/device/token", { deviceCode: bad });
      expect(res.statusCode, String(bad)).toBe(400);
      expect(res.json(), String(bad)).toEqual({ error: "expired_token" });
    }
    expect((await p.call(undefined, "POST", "/v1/auth/device/token")).json()).toEqual({ error: "expired_token" });
  });

  it("a fast poller is told to slow down by five seconds each time, and its early polls count", async () => {
    const p = await make();
    const { body } = await start(p);
    expect((await poll(p, body.deviceCode)).json()).toEqual({ error: "authorization_pending" });
    p.clock.advance(1000);
    const slow = await poll(p, body.deviceCode);
    expect(slow.statusCode).toBe(400);
    expect(slow.json()).toEqual({ error: "slow_down", interval: 10 });
    p.clock.advance(6000); // more than 5 s since the start but only 6 s since a poll that counted: fine
    expect((await poll(p, body.deviceCode)).json()).toEqual({ error: "authorization_pending" });
  });

  it("sanitises the label: control and direction characters are removed, length is cut at 64, missing becomes empty", async () => {
    const p = await make();
    const a = await p.login(alice);
    const label = async (v: unknown) => {
      const { body } = await start(p, v === undefined ? {} : { label: v });
      return (await p.call(a.token, "GET", `/v1/auth/device/${body.userCode}`)).json<{ label: string }>().label;
    };
    expect(await label("  my\u0000 la\nptop‮ ")).toBe("my laptop");
    expect(await label("x".repeat(200))).toHaveLength(64);
    expect(await label(undefined)).toBe("");
    expect(await label(42)).toBe("");
    expect(await label({ a: 1 })).toBe("");
    expect(await label("‮⁦")).toBe("");
  });

  it("writes an audit event for start, approve, deny and token, and never the codes", async () => {
    const p = await make();
    const one = (await start(p, { label: "ci-1" })).body;
    const two = (await start(p, { label: "ci-2" })).body;
    const a = await p.login(alice);
    await p.call(a.token, "POST", `/v1/auth/device/${one.userCode}/approve`);
    await p.call(a.token, "POST", `/v1/auth/device/${two.userCode}/deny`);
    p.clock.advance(5000);
    await poll(p, one.deviceCode);
    const events = (await p.identity.listAudit(0, 100)).filter((e) => e.action.startsWith("device."));
    expect(events.map((e) => [e.action, e.actor, e.detail])).toEqual([
      ["device.start", "system", "ci-1"],
      ["device.start", "system", "ci-2"],
      ["device.approve", a.id, "ci-1"],
      ["device.deny", a.id, "ci-2"],
      ["device.token", a.id, "ci-1"],
    ]);
    const target = `device:${createHash("sha256").update(code(one)).digest("hex").slice(0, 8)}`;
    expect(events[0]?.target).toBe(target);
    expect(events[2]?.target).toBe(target);
    expect(events[4]?.target).toBe(target);
    const text = JSON.stringify(events);
    for (const secret of [one.deviceCode, two.deviceCode, one.userCode, code(one), code(two)]) expect(text).not.toContain(secret);
  });

  it("refuses to hand over a session when the token cannot be audited", async () => {
    const p = await make();
    const { body } = await start(p);
    const a = await p.login(alice);
    await p.call(a.token, "POST", `/v1/auth/device/${body.userCode}/approve`);
    p.clock.advance(5000);
    p.identity.appendAuditFails = true;
    const res = await poll(p, body.deviceCode);
    expect(res.statusCode).toBe(503);
    expect(JSON.stringify(res.json())).not.toContain("sessionToken");
  });

  it("a storage outage is 503 on every device route", async () => {
    const p = await make();
    const { body } = await start(p);
    const a = await p.login(alice);
    p.identity.down = true;
    expect((await p.call(undefined, "POST", "/v1/auth/device", {})).statusCode).toBe(503);
    expect((await poll(p, body.deviceCode)).statusCode).toBe(503);
    p.identity.down = false;
    const b = await p.call(a.token, "GET", `/v1/auth/device/${body.userCode}`);
    expect(b.statusCode).toBe(200);
  });

  it("starting is rate limited per client and says when to come back", async () => {
    const p = await make({ loginRateLimit: { burst: 3, perMinute: 3 } });
    for (let i = 0; i < 3; i++) expect((await start(p)).res.statusCode).toBe(200);
    const res = (await start(p)).res;
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    p.clock.advance(61_000);
    expect((await start(p)).res.statusCode).toBe(200);
  });

  it("looking up and deciding is rate limited too, so a user code cannot be searched for", async () => {
    const p = await make({ loginRateLimit: { burst: 5, perMinute: 5 } });
    const a = await p.login(alice);
    let last = 0;
    for (let i = 0; i < 8; i++) last = (await p.call(a.token, "GET", "/v1/auth/device/BCDFGHJK")).statusCode;
    expect(last).toBe(429);
    expect((await p.call(a.token, "POST", "/v1/auth/device/BCDFGHJK/approve")).statusCode).toBe(429);
  });

  it("retries a colliding user code with a fresh one, and gives up politely after five", async () => {
    const store = new MemoryIdentityStore();
    const real = store.createDeviceAuth.bind(store);
    let refuse = 2;
    const tried: string[] = [];
    store.createDeviceAuth = (i, a) => (tried.push(i.userCode), refuse-- > 0 ? Promise.resolve(false) : real(i, a));
    const p = await make({}, store);
    expect((await start(p)).res.statusCode).toBe(200);
    expect(tried).toHaveLength(3);
    expect(new Set(tried).size).toBe(3); // a new code each time, not the same one again
    tried.length = 0;
    refuse = 99;
    const res = await start(p);
    expect(res.res.statusCode).toBe(409);
    expect(tried).toHaveLength(5);
  });

  it("polling is rate limited only far above the five-second rhythm", async () => {
    const p = await make();
    let status = 0;
    for (let i = 0; i < 60; i++) status = (await poll(p, "a".repeat(43))).statusCode;
    expect(status).toBe(400);
    const res = await poll(p, "a".repeat(43));
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("device answers are never cached, errors included", async () => {
    const p = await make();
    const a = await p.login(alice);
    for (const r of [await poll(p, "x"), await p.call(a.token, "GET", "/v1/auth/device/BCDFGHJK"), await p.call(a.token, "POST", "/v1/auth/device/BCDFGHJK/approve")]) {
      expect(r.headers["cache-control"]).toBe("no-store");
    }
  });

  it("a body that is not an object, or is too large, never reaches the store", async () => {
    const p = await make();
    expect((await p.call(undefined, "POST", "/v1/auth/device", "nonsense")).statusCode).toBeLessThan(500);
    expect((await p.call(undefined, "POST", "/v1/auth/device", { label: "x".repeat(100_000) })).statusCode).toBe(413);
  });
});
