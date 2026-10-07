import { describe, expect, it } from "vitest";
import { DeviceLoginError, decideDeviceRequest, describeDeviceRequest, pollDeviceLogin, startDeviceLogin, type DeviceLoginStart } from "../src/device-login.js";

const CP = "https://cp.example.com/";
const START: DeviceLoginStart = {
  deviceCode: "d".repeat(43),
  userCode: "BCDF-GHJK",
  verificationUri: "https://app.example.com/",
  verificationUriComplete: "https://app.example.com/?device=BCDF-GHJK",
  expiresInS: 600,
  intervalS: 5,
};
const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A fake clock whose sleep advances time, and a fetch that plays back answers. */
function world(answers: (Response | Error)[], fetchMs = 0) {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    t += fetchMs; // a slow network
    const a = answers.shift();
    if (a === undefined) throw new Error("no more answers");
    if (a instanceof Error) throw a;
    return a;
  }) as typeof globalThis.fetch;
  return {
    calls,
    sleeps,
    opts: { fetch, now: () => t, sleep: async (ms: number) => void (sleeps.push(ms), (t += ms)) },
  };
}
const pending = () => json(400, { error: "authorization_pending" });

describe("startDeviceLogin", () => {
  it("posts the label to the control plane and returns the request", async () => {
    const w = world([json(200, START)]);
    expect(await startDeviceLogin(CP, { label: "build agent", fetch: w.opts.fetch })).toEqual(START);
    expect(w.calls[0]?.url).toBe("https://cp.example.com/v1/auth/device");
    expect(w.calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(w.calls[0]?.init?.body))).toEqual({ label: "build agent" });
    expect(new Headers(w.calls[0]?.init?.headers).get("content-type")).toBe("application/json");
  });
  it("sends an empty object without a label", async () => {
    const w = world([json(200, START)]);
    await startDeviceLogin(CP, { fetch: w.opts.fetch });
    expect(JSON.parse(String(w.calls[0]?.init?.body))).toEqual({});
  });
  it("explains a refusal, a server that has device login off, and an unreadable answer", async () => {
    await expect(startDeviceLogin(CP, { fetch: world([json(404, { error: "device login not configured" })]).opts.fetch })).rejects.toMatchObject({ code: "refused", status: 404, message: expect.stringContaining("device login not configured") });
    await expect(startDeviceLogin(CP, { fetch: world([json(429, { error: "too many requests" })]).opts.fetch })).rejects.toMatchObject({ code: "refused", status: 429 });
    await expect(startDeviceLogin(CP, { fetch: world([json(200, { ...START, deviceCode: 5 })]).opts.fetch })).rejects.toMatchObject({ code: "unexpected" });
    await expect(startDeviceLogin(CP, { fetch: world([json(200, { ...START, intervalS: 0 })]).opts.fetch })).rejects.toMatchObject({ code: "unexpected" });
    await expect(startDeviceLogin(CP, { fetch: world([json(200, { ...START, expiresInS: 0 })]).opts.fetch })).rejects.toMatchObject({ code: "unexpected" });
    await expect(startDeviceLogin(CP, { fetch: world([new Response("<html>", { status: 502 })]).opts.fetch })).rejects.toMatchObject({ code: "refused", status: 502 });
    await expect(startDeviceLogin(CP, { fetch: world([new Error("ECONNREFUSED")]).opts.fetch })).rejects.toMatchObject({ code: "network" });
  });
});

describe("pollDeviceLogin", () => {
  it("waits one interval before the first poll, then returns the session token", async () => {
    const w = world([pending(), pending(), json(200, { sessionToken: "tok" })]);
    expect(await pollDeviceLogin(CP, START, w.opts)).toEqual({ sessionToken: "tok" });
    expect(w.sleeps).toEqual([5000, 5000, 5000]);
    expect(w.calls.map((c) => c.url)).toEqual(Array(3).fill("https://cp.example.com/v1/auth/device/token"));
    expect(JSON.parse(String(w.calls[0]?.init?.body))).toEqual({ deviceCode: START.deviceCode });
  });

  it("slows down by the server's interval, or by five seconds when it names none", async () => {
    const w = world([json(400, { error: "slow_down", interval: 12 }), pending(), json(400, { error: "slow_down" }), pending(), json(200, { sessionToken: "t" })]);
    await pollDeviceLogin(CP, START, w.opts);
    expect(w.sleeps).toEqual([5000, 12_000, 12_000, 17_000, 17_000]);
  });

  it("never slows to an interval shorter than it already uses", async () => {
    const w = world([json(400, { error: "slow_down", interval: 1 }), json(200, { sessionToken: "t" })]);
    await pollDeviceLogin(CP, START, w.opts);
    expect(w.sleeps).toEqual([5000, 10_000]);
  });

  it("reports a denial and an expired code, once", async () => {
    await expect(pollDeviceLogin(CP, START, world([pending(), json(400, { error: "access_denied" })]).opts)).rejects.toMatchObject({ name: "DeviceLoginError", code: "access_denied" });
    const w = world([json(400, { error: "expired_token" })]);
    await expect(pollDeviceLogin(CP, START, w.opts)).rejects.toMatchObject({ code: "expired_token" });
    expect(w.calls).toHaveLength(1);
  });

  it("gives up when the lifetime has passed, without polling or sleeping again", async () => {
    const w = world(Array.from({ length: 200 }, pending));
    await expect(pollDeviceLogin(CP, { ...START, expiresInS: 20 }, w.opts)).rejects.toMatchObject({ code: "expired_token" });
    expect(w.calls).toHaveLength(3); // at 5, 10 and 15 s; the wait that ends at 20 s is the end, not a fourth poll
    expect(w.sleeps).toEqual([5000, 5000, 5000, 5000]);
    const exact = world(Array.from({ length: 200 }, pending));
    await expect(pollDeviceLogin(CP, { ...START, expiresInS: 15 }, exact.opts)).rejects.toMatchObject({ code: "expired_token" });
    expect(exact.sleeps).toEqual([5000, 5000, 5000]); // 15 s is the end of the lifetime: no third poll
    expect(exact.calls).toHaveLength(2);
    // a slow network can use the lifetime up during a poll: then there is no further wait at all
    const slow = world(Array.from({ length: 200 }, pending), 8000);
    await expect(pollDeviceLogin(CP, { ...START, expiresInS: 12 }, slow.opts)).rejects.toMatchObject({ code: "expired_token" });
    expect(slow.sleeps).toEqual([5000]);
  });

  it("rides out a few network failures and server errors, then gives up", async () => {
    const ok = world([new Error("reset"), json(503, { error: "storage unavailable" }), json(200, { sessionToken: "t" })]);
    expect((await pollDeviceLogin(CP, START, ok.opts)).sessionToken).toBe("t");
    const dead = world(Array.from({ length: 20 }, () => new Error("reset")));
    await expect(pollDeviceLogin(CP, START, dead.opts)).rejects.toMatchObject({ code: "network" });
    expect(dead.calls).toHaveLength(5);
    // a success in between resets the count
    const mixed = world([new Error("a"), new Error("b"), new Error("c"), new Error("d"), pending(), new Error("e"), new Error("f"), new Error("g"), new Error("h"), json(200, { sessionToken: "t" })]);
    expect((await pollDeviceLogin(CP, START, mixed.opts)).sessionToken).toBe("t");
  });

  it("honours retry-after on a 429 instead of its own interval", async () => {
    const w = world([json(429, { error: "too many requests" }, { "retry-after": "30" }), json(200, { sessionToken: "t" })]);
    await pollDeviceLogin(CP, START, w.opts);
    expect(w.sleeps).toEqual([5000, 30_000]);
  });

  it("never shortens its wait because the server asked for less", async () => {
    const w = world([json(429, { error: "too many requests" }, { "retry-after": "1" }), json(200, { sessionToken: "t" })]);
    await pollDeviceLogin(CP, START, w.opts);
    expect(w.sleeps).toEqual([5000, 5000]);
  });

  it("treats an answer it does not understand as an error, not as success", async () => {
    await expect(pollDeviceLogin(CP, START, world([json(200, {})]).opts)).rejects.toMatchObject({ code: "unexpected" });
    await expect(pollDeviceLogin(CP, START, world([json(400, { error: "invent" })]).opts)).rejects.toMatchObject({ code: "unexpected" });
    await expect(pollDeviceLogin(CP, START, world([json(200, { sessionToken: "" })]).opts)).rejects.toMatchObject({ code: "unexpected" });
    await expect(pollDeviceLogin(CP, START, world([new Response("nope", { status: 400 })]).opts)).rejects.toMatchObject({ code: "unexpected" });
  });

  it("stops at once when aborted, before and during a wait", async () => {
    const early = new AbortController();
    early.abort();
    const never = world([]);
    await expect(pollDeviceLogin(CP, START, { ...never.opts, signal: early.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(never.sleeps).toEqual([]);
    expect(never.calls).toEqual([]);
    const mid = new AbortController();
    const w = world([pending(), pending()]);
    let n = 0;
    const sleep = async () => {
      if (++n === 2) mid.abort();
    };
    await expect(pollDeviceLogin(CP, START, { ...w.opts, sleep, signal: mid.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(w.calls).toHaveLength(1);
  });

  it("really sleeps, and an abort wakes the default sleep", async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 20);
    const t0 = Date.now();
    await expect(pollDeviceLogin(CP, START, { fetch: world([]).opts.fetch, signal: ctl.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(Date.now() - t0).toBeLessThan(2000); // not the five seconds
  });

  it("is a DeviceLoginError", () => {
    expect(new DeviceLoginError("network", "x")).toBeInstanceOf(Error);
  });
});

describe("approving side", () => {
  const info = { label: "build agent", createdAtMs: 1, expiresAtMs: 2, status: "pending" };
  it("looks a request up with the session and an encoded code", async () => {
    const w = world([json(200, info)]);
    expect(await describeDeviceRequest(CP, "sess", "BCDF-GHJK", { fetch: w.opts.fetch })).toEqual(info);
    expect(w.calls[0]?.url).toBe("https://cp.example.com/v1/auth/device/BCDF-GHJK");
    expect(new Headers(w.calls[0]?.init?.headers).get("authorization")).toBe("Bearer sess");
    const odd = world([json(404, { error: "no such request" })]);
    await expect(describeDeviceRequest(CP, "s", "a/b?c", { fetch: odd.opts.fetch })).rejects.toMatchObject({ code: "refused", status: 404 });
    expect(odd.calls[0]?.url).toBe("https://cp.example.com/v1/auth/device/a%2Fb%3Fc");
  });
  it("rejects a lookup answer of the wrong shape", async () => {
    for (const bad of [{ label: 5 }, { ...info, label: 5 }, { ...info, createdAtMs: "1" }, { ...info, expiresAtMs: null }, { ...info, status: 1 }]) {
      await expect(describeDeviceRequest(CP, "s", "X", { fetch: world([json(200, bad)]).opts.fetch }), JSON.stringify(bad)).rejects.toMatchObject({ code: "unexpected" });
    }
  });
  it("approves and denies by POST, and reports 409 and 401", async () => {
    const w = world([json(200, { approved: true }), json(200, { denied: true })]);
    await decideDeviceRequest(CP, "sess", "BCDF-GHJK", "approve", { fetch: w.opts.fetch });
    await decideDeviceRequest(CP, "sess", "BCDF-GHJK", "deny", { fetch: w.opts.fetch });
    const odd = world([json(404, { error: "x" })]);
    await decideDeviceRequest(CP, "sess", "a/b", "approve", { fetch: odd.opts.fetch }).catch(() => undefined);
    expect(odd.calls[0]?.url).toBe("https://cp.example.com/v1/auth/device/a%2Fb/approve");
    expect(w.calls.map((c) => [c.url, c.init?.method])).toEqual([
      ["https://cp.example.com/v1/auth/device/BCDF-GHJK/approve", "POST"],
      ["https://cp.example.com/v1/auth/device/BCDF-GHJK/deny", "POST"],
    ]);
    await expect(decideDeviceRequest(CP, "s", "X", "approve", { fetch: world([json(409, { error: "this request was already decided" })]).opts.fetch })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("already decided") });
    await expect(decideDeviceRequest(CP, "s", "X", "approve", { fetch: world([json(401, { error: "invalid or expired session" })]).opts.fetch })).rejects.toMatchObject({ status: 401 });
  });
});
