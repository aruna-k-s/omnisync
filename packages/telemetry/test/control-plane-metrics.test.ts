import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneMetrics } from "../src/control-plane-metrics.js";
import { sample, series, testMeter } from "../src/testing.js";

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.map((f) => f()));
  cleanup = [];
});
function setup() {
  const t = testMeter();
  cleanup.push(t.shutdown);
  return { ...t, m: new ControlPlaneMetrics(t.meter) };
}

describe("http request timing", () => {
  it("records route, method and status class", async () => {
    const { m, scrape } = setup();
    m.request({ route: "/v1/me", method: "GET", status: 200, seconds: 0.004 });
    m.request({ route: "/v1/me", method: "GET", status: 401, seconds: 0.002 });
    m.request({ route: "/v1/documents/:id/grants", method: "PUT", status: 500, seconds: 0.2 });
    const text = await scrape();
    expect(text).toContain("# TYPE omnisync_http_request_seconds histogram");
    expect(sample(text, "omnisync_http_request_seconds_count", { route: "/v1/me", method: "GET", status_class: "2xx" })).toBe(1);
    expect(sample(text, "omnisync_http_request_seconds_count", { route: "/v1/me", method: "GET", status_class: "4xx" })).toBe(1);
    expect(sample(text, "omnisync_http_request_seconds_count", { route: "/v1/documents/:id/grants", method: "PUT", status_class: "5xx" })).toBe(1);
    expect(sample(text, "omnisync_http_request_seconds_sum", { route: "/v1/me", method: "GET", status_class: "2xx" })).toBeCloseTo(0.004, 6);
  });
  it("uses the documented bucket boundaries", async () => {
    const { m, scrape } = setup();
    m.request({ route: "/v1/me", method: "GET", status: 200, seconds: 0.01 });
    const les = series(await scrape(), "omnisync_http_request_seconds_bucket")
      .map((s) => s["le"])
      .filter((x): x is string => x !== undefined && x !== "+Inf")
      .map(Number)
      .sort((a, b) => a - b);
    expect(les).toEqual([0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);
  });
  it("reports an unmatched route as unmatched", async () => {
    const { m, scrape } = setup();
    m.request({ route: undefined, method: "GET", status: 404, seconds: 0.001 });
    expect(sample(await scrape(), "omnisync_http_request_seconds_count", { route: "unmatched", method: "GET", status_class: "4xx" })).toBe(1);
  });
  it("never lets client input into a label", async () => {
    const { m, scrape } = setup();
    for (const route of ["http://evil/", "no-slash", "/" + "a".repeat(500), "/v1/x\n{injected}", "", "/v1/\"quote"]) {
      m.request({ route, method: "GET", status: 200, seconds: 0.001 });
    }
    for (const method of ["PROPFIND", "get", "BREW", "__proto__", "X".repeat(1000)]) m.request({ route: "/v1/me", method, status: 200, seconds: 0.001 });
    for (const status of [0, 99, 600, 1000, -5, Number.NaN]) m.request({ route: "/v1/me", method: "GET", status, seconds: 0.001 });
    const text = await scrape();
    expect(text).not.toContain("evil");
    expect(text).not.toContain("injected");
    expect(text).not.toContain("PROPFIND");
    expect(text).not.toContain("BREW");
    const s = series(text, "omnisync_http_request_seconds_count");
    for (const labels of s) {
      expect(["unmatched", "/v1/me"]).toContain(labels["route"]);
      expect(["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "other"]).toContain(labels["method"]);
      expect(["2xx", "3xx", "4xx", "5xx", "other"]).toContain(labels["status_class"]);
    }
  });
  it("bounds the number of distinct routes", async () => {
    const { m, scrape } = setup();
    for (let i = 0; i < 500; i++) m.request({ route: `/v1/r${i}`, method: "GET", status: 200, seconds: 0.001 });
    const routes = new Set(series(await scrape(), "omnisync_http_request_seconds_count").map((s) => s["route"]));
    expect(routes.size).toBeLessThanOrEqual(65);
    expect(routes.has("other")).toBe(true);
  });
  it("ignores impossible durations", async () => {
    const { m, scrape } = setup();
    for (const seconds of [Number.NaN, -1, Infinity]) m.request({ route: "/v1/me", method: "GET", status: 200, seconds });
    expect(sample(await scrape(), "omnisync_http_request_seconds_count", { route: "/v1/me", method: "GET", status_class: "2xx" })).toBeUndefined();
  });
});

describe("derived counters", () => {
  it("counts logins by the callback route's result", async () => {
    const { m, scrape } = setup();
    const cb = (status: number) => m.request({ route: "/v1/auth/callback", method: "GET", status, seconds: 0.01 });
    cb(200);
    cb(302);
    cb(400);
    cb(502);
    cb(429);
    const text = await scrape();
    expect(sample(text, "omnisync_logins_total", { outcome: "ok" })).toBe(2);
    expect(sample(text, "omnisync_logins_total", { outcome: "failed" })).toBe(3);
  });
  it("does not count other routes as logins, and the login redirect is not a login", async () => {
    const { m, scrape } = setup();
    m.request({ route: "/v1/auth/login", method: "GET", status: 302, seconds: 0.01 });
    m.request({ route: "/v1/me", method: "GET", status: 200, seconds: 0.01 });
    expect(series(await scrape(), "omnisync_logins_total")).toHaveLength(0);
  });
  it("counts issued certificates only for a successful POST", async () => {
    const { m, scrape } = setup();
    const issue = (method: string, status: number) => m.request({ route: "/v1/certificates", method, status, seconds: 0.01 });
    issue("POST", 201);
    issue("POST", 200);
    issue("POST", 400);
    issue("POST", 403);
    issue("GET", 200);
    m.request({ route: "/v1/certificates/:serial/revoke", method: "POST", status: 200, seconds: 0.01 });
    expect(sample(await scrape(), "omnisync_certificates_issued_total")).toBe(2);
  });
  it("counts 429s by route", async () => {
    const { m, scrape } = setup();
    m.request({ route: "/v1/auth/login", method: "GET", status: 429, seconds: 0.001 });
    m.request({ route: "/v1/auth/login", method: "GET", status: 429, seconds: 0.001 });
    m.request({ route: "/v1/device/code", method: "POST", status: 429, seconds: 0.001 });
    m.request({ route: "/v1/me", method: "GET", status: 200, seconds: 0.001 });
    const text = await scrape();
    expect(sample(text, "omnisync_rate_limited_total", { route: "/v1/auth/login" })).toBe(2);
    expect(sample(text, "omnisync_rate_limited_total", { route: "/v1/device/code" })).toBe(1);
    expect(series(text, "omnisync_rate_limited_total")).toHaveLength(2);
  });
});

describe("derived counters, edges", () => {
  it("counts a login only for GET on the callback route", async () => {
    const { m, scrape } = setup();
    m.request({ route: "/v1/auth/callback", method: "POST", status: 200, seconds: 0.01 });
    m.request({ route: "/v1/auth/callback", method: "PUT", status: 500, seconds: 0.01 });
    expect(series(await scrape(), "omnisync_logins_total")).toHaveLength(0);
  });
  it("counts only 429 as rate limited", async () => {
    const { m, scrape } = setup();
    for (const status of [400, 401, 403, 404, 409, 428, 430, 500, 503]) m.request({ route: "/v1/me", method: "GET", status, seconds: 0.01 });
    expect(series(await scrape(), "omnisync_rate_limited_total")).toHaveLength(0);
  });
  it("reports informational statuses as other, not as a class", async () => {
    const { m, scrape } = setup();
    for (const status of [100, 101, 199]) m.request({ route: "/v1/me", method: "GET", status, seconds: 0.01 });
    const s = series(await scrape(), "omnisync_http_request_seconds_count");
    expect(s.map((x) => x["status_class"])).toEqual(["other"]);
  });
  it("records exactly the seconds given", async () => {
    const { m, scrape } = setup();
    m.request({ route: "/v1/me", method: "GET", status: 200, seconds: 0 });
    m.request({ route: "/v1/me", method: "GET", status: 200, seconds: 0.5 });
    const text = await scrape();
    expect(sample(text, "omnisync_http_request_seconds_count", { route: "/v1/me", method: "GET", status_class: "2xx" })).toBe(2);
    expect(sample(text, "omnisync_http_request_seconds_sum", { route: "/v1/me", method: "GET", status_class: "2xx" })).toBeCloseTo(0.5, 9);
  });
});

describe("observer only", () => {
  it("a meter that throws on every call does not throw out of request()", () => {
    const throwing = new Proxy({}, { get: () => () => { throw new Error("meter broke"); } }) as never;
    expect(() => {
      const m = new ControlPlaneMetrics(throwing);
      m.request({ route: "/v1/me", method: "GET", status: 200, seconds: 0.1 });
    }).not.toThrow();
  });
  it("the default meter is a working no-op", () => {
    new ControlPlaneMetrics().request({ route: "/v1/me", method: "GET", status: 200, seconds: 0.1 });
  });
});
