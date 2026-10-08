import { afterEach, describe, expect, it } from "vitest";
import { parseTrustProxy } from "../src/config.js";
import { startPlane, type Plane } from "./helpers.js";

describe("parseTrustProxy (OMNISYNC_TRUST_PROXY)", () => {
  it("is off when unset or empty", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("   ")).toBe(false);
    expect(parseTrustProxy("0")).toBe(false);
  });

  it("takes a hop count", () => {
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy(" 2 ")).toBe(2);
    expect(parseTrustProxy("5")).toBe(5);
  });

  it("takes addresses and CIDR ranges of the proxies to trust", () => {
    expect(parseTrustProxy("10.0.0.0/8")).toEqual(["10.0.0.0/8"]);
    expect(parseTrustProxy("10.0.0.0/8, 192.168.1.5 ,fd00::/8")).toEqual(["10.0.0.0/8", "192.168.1.5", "fd00::/8"]);
    expect(parseTrustProxy("::1")).toEqual(["::1"]);
    expect(parseTrustProxy("fd00::/64, ::1/128, 10.0.0.1/32")).toEqual(["fd00::/64", "::1/128", "10.0.0.1/32"]);
  });

  it("refuses to trust everyone, and refuses anything it cannot read", () => {
    for (const bad of ["true", "false", "all", "*", "-1", "6", "100", "1.5", "1e1", "0x1", "00", "10.0.0.0/33", "::1/129", "fd00::/0", "10.0.0.256", "10.0.0.0/8,", "10.0.0.0/8,,1", "a.b.c.d", "10.0.0.0/-1", "0.0.0.0/0", "::/0", "1,2"]) {
      expect(() => parseTrustProxy(bad), bad).toThrow(/OMNISYNC_TRUST_PROXY/);
    }
  });

  it("never repeats the value in the message", () => {
    expect(() => parseTrustProxy("hunter2")).toThrow(/OMNISYNC_TRUST_PROXY/);
    try {
      parseTrustProxy("hunter2");
    } catch (e) {
      expect((e as Error).message).not.toContain("hunter2");
    }
  });
});

describe("the client address behind a proxy", () => {
  const planes: Plane[] = [];
  afterEach(async () => {
    await Promise.allSettled(planes.splice(0).map((p) => p.close()));
  });
  const hit = (p: Plane, xff?: string, peer = "10.1.2.3") =>
    p.app.inject({ method: "GET", url: "/v1/auth/login", remoteAddress: peer, ...(xff ? { headers: { "x-forwarded-for": xff } } : {}) });

  it("without trustProxy everyone behind the proxy shares one limit, and a forged header changes nothing", async () => {
    const p = await startPlane({ loginRateLimit: { burst: 2, perMinute: 2 } });
    planes.push(p);
    expect((await hit(p, "1.1.1.1")).statusCode).toBe(302);
    expect((await hit(p, "2.2.2.2")).statusCode).toBe(302);
    expect((await hit(p, "3.3.3.3")).statusCode).toBe(429);
  });

  it("with one trusted hop each client address has its own limit", async () => {
    const p = await startPlane({ trustProxy: 1, loginRateLimit: { burst: 2, perMinute: 2 } });
    planes.push(p);
    expect((await hit(p, "1.1.1.1")).statusCode).toBe(302);
    expect((await hit(p, "1.1.1.1")).statusCode).toBe(302);
    expect((await hit(p, "1.1.1.1")).statusCode).toBe(429);
    expect((await hit(p, "2.2.2.2")).statusCode).toBe(302); // another client behind the same proxy
  });

  it("a client cannot choose its own address by prepending to the header: only the last hop is trusted", async () => {
    const p = await startPlane({ trustProxy: 1, loginRateLimit: { burst: 1, perMinute: 1 } });
    planes.push(p);
    // The proxy appends the address it saw; whatever the client wrote before it is ignored.
    expect((await hit(p, "9.9.9.1, 1.1.1.1")).statusCode).toBe(302);
    expect((await hit(p, "9.9.9.2, 1.1.1.1")).statusCode).toBe(429);
  });

  it("with a CIDR list, a header from a peer outside it is ignored", async () => {
    const p = await startPlane({ trustProxy: ["10.0.0.0/8"], loginRateLimit: { burst: 1, perMinute: 1 } });
    planes.push(p);
    expect((await hit(p, "1.1.1.1", "10.1.2.3")).statusCode).toBe(302);
    expect((await hit(p, "2.2.2.2", "10.1.2.3")).statusCode).toBe(302);
    // a peer outside the trusted range is itself the client; its header is not believed
    expect((await hit(p, "3.3.3.3", "203.0.113.7")).statusCode).toBe(302);
    expect((await hit(p, "4.4.4.4", "203.0.113.7")).statusCode).toBe(429);
  });
});
