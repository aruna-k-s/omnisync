import { afterEach, describe, expect, it } from "vitest";
import { signEnrollmentProof } from "@omnisync/crypto";
import { generateKeyPair } from "@omnisync/protocol";
import { MemoryIdentityStore } from "@omnisync/store";
import { ControlPlaneMetrics } from "@omnisync/telemetry";
import { sample, series, testMeter } from "@omnisync/telemetry/testing";
import { startPlane, type Plane } from "./helpers.js";

const alice = { sub: "alice-sub", email: "alice@example.com", name: "Alice" };

describe("control plane metrics", () => {
  const planes: Plane[] = [];
  const meters: { shutdown: () => Promise<void> }[] = [];
  afterEach(async () => {
    await Promise.allSettled(planes.splice(0).map((p) => p.close()));
    await Promise.allSettled(meters.splice(0).map((m) => m.shutdown()));
  });
  async function make(over: Parameters<typeof startPlane>[0] = {}) {
    const m = testMeter();
    meters.push(m);
    const p = await startPlane(over, undefined, undefined, { metrics: new ControlPlaneMetrics(m.meter) });
    planes.push(p);
    return { p, m };
  }

  it("counts a successful login and times the callback route", async () => {
    const { p, m } = await make();
    await p.login(alice);
    const text = await m.scrape();
    expect(sample(text, "omnisync_logins_total", { outcome: "ok" })).toBe(1);
    expect(sample(text, "omnisync_http_request_seconds_count", { route: "/v1/auth/callback", method: "GET", status_class: "2xx" })).toBe(1);
    expect(sample(text, "omnisync_http_request_seconds_count", { route: "/v1/auth/login", method: "GET", status_class: "3xx" })).toBe(1);
  });

  it("counts a refused login", async () => {
    const { p, m } = await make();
    const { callback } = await p.begin();
    const res = await p.app.inject({ method: "GET", url: callback }); // no cookie: the login was not started in this browser
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(sample(await m.scrape(), "omnisync_logins_total", { outcome: "failed" })).toBe(1);
  });

  it("counts an issued certificate", async () => {
    const { p, m } = await make();
    const { token, id } = await p.login(alice);
    const { res } = await p.enroll(token, id);
    expect(res.statusCode).toBe(201);
    const text = await m.scrape();
    expect(sample(text, "omnisync_certificates_issued_total")).toBe(1);
    expect(sample(text, "omnisync_http_request_seconds_count", { route: "/v1/certificates", method: "POST", status_class: "2xx" })).toBe(1);
  });

  it("does not count a refused certificate request as issued", async () => {
    const { p, m } = await make();
    const { token, id } = await p.login(alice);
    const mine = generateKeyPair(new Uint8Array(32).fill(70));
    const other = generateKeyPair(new Uint8Array(32).fill(71));
    const res = await p.call(token, "POST", "/v1/certificates", {
      publicKey: Buffer.from(mine.publicKey).toString("base64url"),
      proof: Buffer.from(signEnrollmentProof(id, mine.publicKey, other.secretKey)).toString("base64url"),
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(sample(await m.scrape(), "omnisync_certificates_issued_total")).toBeUndefined();
  });

  it("counts throttled requests by route", async () => {
    const { p, m } = await make({ loginRateLimit: { burst: 2, perMinute: 6 } });
    for (let i = 0; i < 4; i++) await p.app.inject({ method: "GET", url: "/v1/auth/login" });
    const text = await m.scrape();
    expect(sample(text, "omnisync_rate_limited_total", { route: "/v1/auth/login" })).toBe(2);
    expect(sample(text, "omnisync_http_request_seconds_count", { route: "/v1/auth/login", method: "GET", status_class: "4xx" })).toBe(2);
  });

  it("reports an unknown path as unmatched", async () => {
    const { p, m } = await make();
    const res = await p.app.inject({ method: "GET", url: "/no/such/thing" });
    expect(res.statusCode).toBe(404);
    expect(sample(await m.scrape(), "omnisync_http_request_seconds_count", { route: "unmatched", method: "GET", status_class: "4xx" })).toBe(1);
  });

  it("never puts identifiers, query strings or tokens into a label", async () => {
    const { p, m } = await make();
    const { token } = await p.login(alice);
    await p.call(token, "GET", "/v1/documents/SECRET-DOC-ID/grants?probe=secret-query");
    await p.call(token, "PUT", "/v1/documents/SECRET-DOC-ID/grants/SECRET-PRINCIPAL", { role: "write" });
    await p.app.inject({ method: "GET", url: "/v1/anything/SECRET-DOC-ID?token=" + token });
    const text = await m.scrape();
    for (const secret of ["SECRET-DOC-ID", "SECRET-PRINCIPAL", "secret-query", token, "alice@example.com", "Alice"]) expect(text).not.toContain(secret);
    expect(sample(text, "omnisync_http_request_seconds_count", { route: "/v1/documents/:id/grants", method: "GET", status_class: "4xx" }) ?? 0).toBeGreaterThanOrEqual(0);
    const routes = new Set(series(text, "omnisync_http_request_seconds_count").map((s) => s["route"]));
    expect(routes.has("/v1/documents/:id/grants")).toBe(true);
    expect(routes.has("/v1/documents/:id/grants/:principalId")).toBe(true);
  });

  it("does not serve /metrics on the application port", async () => {
    const { p } = await make();
    expect((await p.app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(404);
  });

  it("a meter that throws on every call does not change any response", async () => {
    const throwing = new Proxy({}, { get: () => () => { throw new Error("meter broke"); } }) as never;
    const p = await startPlane({}, undefined, undefined, { metrics: new ControlPlaneMetrics(throwing) });
    planes.push(p);
    const { token, id } = await p.login(alice);
    expect((await p.call(token, "GET", "/v1/me")).json()).toMatchObject({ id });
    expect((await p.call(undefined, "GET", "/v1/me")).statusCode).toBe(401);
  });

  it("reports durations in seconds", async () => {
    class Slow extends MemoryIdentityStore {
      override async getPrincipal(id: string) {
        await new Promise((r) => setTimeout(r, 150));
        return super.getPrincipal(id);
      }
    }
    const m = testMeter();
    meters.push(m);
    const p = await startPlane({}, new Slow(), undefined, { metrics: new ControlPlaneMetrics(m.meter) });
    planes.push(p);
    const { token } = await p.login(alice);
    await p.call(token, "GET", "/v1/me");
    const text = await m.scrape();
    const labels = { route: "/v1/me", method: "GET", status_class: "2xx" };
    const sum = sample(text, "omnisync_http_request_seconds_sum", labels) ?? 0;
    expect(sample(text, "omnisync_http_request_seconds_count", labels)).toBe(1);
    expect(sum).toBeGreaterThanOrEqual(0.14);
    expect(sum).toBeLessThan(5);
  });

  it("works unchanged without metrics", async () => {
    const p = await startPlane();
    planes.push(p);
    const { token } = await p.login(alice);
    expect((await p.call(token, "GET", "/v1/me")).statusCode).toBe(200);
  });
});
