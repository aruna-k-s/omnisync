import { afterEach, describe, expect, it } from "vitest";
import { startPlane, type Plane } from "./helpers.js";

const APP = "https://console.example.com/app/";

describe("CORS for the console", () => {
  const planes: Plane[] = [];
  afterEach(async () => {
    await Promise.allSettled(planes.splice(0).map((p) => p.close()));
  });
  const make = async (over: Parameters<typeof startPlane>[0]) => {
    const p = await startPlane(over);
    planes.push(p);
    return p;
  };

  it("answers an allowed origin's preflight and tags its responses; the origin is echoed exactly", async () => {
    const p = await make({ returnTo: [APP, "http://localhost:4200/"] });
    const pre = await p.app.inject({
      method: "OPTIONS",
      url: "/v1/admin/principals",
      headers: { origin: "https://console.example.com", "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("https://console.example.com");
    expect(pre.headers["access-control-allow-methods"]).toBe("GET, POST, PUT, DELETE");
    expect(pre.headers["access-control-allow-headers"]).toBe("authorization, content-type");
    expect(pre.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(pre.headers["vary"]).toBe("Origin");

    const res = await p.app.inject({ method: "GET", url: "/healthz", headers: { origin: "http://localhost:4200" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:4200");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    // Errors carry it too, or the browser would hide the status from the page.
    const denied = await p.app.inject({ method: "GET", url: "/v1/admin/principals", headers: { origin: "https://console.example.com" } });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers["access-control-allow-origin"]).toBe("https://console.example.com");
  });

  it("gives other origins nothing, and nothing at all when no return_to is configured", async () => {
    const p = await make({ returnTo: [APP] });
    for (const origin of ["https://evil.example.com", "https://console.example.com.evil.com", "http://console.example.com", "null", "https://console.example.com:8443"]) {
      const res = await p.app.inject({ method: "GET", url: "/healthz", headers: { origin } });
      expect(res.headers["access-control-allow-origin"], origin).toBeUndefined();
      const pre = await p.app.inject({ method: "OPTIONS", url: "/v1/me", headers: { origin, "access-control-request-method": "GET" } });
      expect(pre.headers["access-control-allow-origin"], origin).toBeUndefined();
      expect(pre.statusCode, origin).not.toBe(204);
    }
    const bare = await make({});
    const res = await bare.app.inject({ method: "GET", url: "/healthz", headers: { origin: "https://console.example.com" } });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    const pre = await bare.app.inject({ method: "OPTIONS", url: "/v1/me", headers: { origin: "https://console.example.com", "access-control-request-method": "GET" } });
    expect(pre.statusCode).not.toBe(204);
  });
});
