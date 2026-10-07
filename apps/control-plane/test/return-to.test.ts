import { afterEach, describe, expect, it } from "vitest";
import { cookieOf, startPlane, type Plane } from "./helpers.js";

const APP = "https://console.example.com/app/";
const LOCAL = "http://localhost:4200/";
const alice = { sub: "alice-sub", email: "alice@example.com", name: "Alice" };

describe("browser login (return_to)", () => {
  const planes: Plane[] = [];
  const make = async (over: Parameters<typeof startPlane>[0] = { returnTo: [APP, LOCAL] }) => {
    const p = await startPlane(over);
    planes.push(p);
    p.idp.user = alice;
    return p;
  };
  afterEach(async () => {
    await Promise.allSettled(planes.splice(0).map((p) => p.close()));
  });

  const cookies = (res: { headers: Record<string, unknown> }): string[] => {
    const set = res.headers["set-cookie"];
    return (Array.isArray(set) ? set : [set]).map((c) => String(c));
  };
  const jar = (res: { headers: Record<string, unknown> }): string =>
    cookies(res)
      .map((c) => c.split(";")[0])
      .join("; ");

  it("redirects an allowlisted return_to with the session in the fragment, and the token works", async () => {
    const p = await make();
    const start = await p.app.inject({ method: "GET", url: `/v1/auth/login?return_to=${encodeURIComponent(APP)}` });
    expect(start.statusCode).toBe(302);
    expect(cookies(start)).toHaveLength(2);
    expect(cookies(start).every((c) => c.includes("HttpOnly") && c.includes("SameSite=Lax") && c.includes("Path=/v1/auth"))).toBe(true);

    const callback = await p.idp.browse(start.headers["location"] as string);
    const res = await p.app.inject({ method: "GET", url: callback, headers: { cookie: jar(start) } });
    expect(res.statusCode).toBe(302);
    expect(res.headers["cache-control"]).toBe("no-store");
    const loc = String(res.headers["location"]);
    expect(loc.startsWith(`${APP}#session=`)).toBe(true);
    expect(loc).not.toContain("?session"); // fragment, never the query string
    const token = decodeURIComponent(loc.slice(loc.indexOf("#session=") + 9));
    expect((await p.call(token, "GET", "/v1/me")).json()).toMatchObject({ email: "alice@example.com" });
    expect(res.body).not.toContain(token); // not in the body either
    expect(cookies(res).every((c) => c.includes("Max-Age=0"))).toBe(true); // both cookies cleared
    expect(cookies(res)).toHaveLength(2);
  });

  it("accepts http on localhost when allowlisted", async () => {
    const p = await make();
    const start = await p.app.inject({ method: "GET", url: `/v1/auth/login?return_to=${encodeURIComponent(LOCAL)}` });
    expect(start.statusCode).toBe(302);
    const res = await p.app.inject({ method: "GET", url: await p.idp.browse(start.headers["location"] as string), headers: { cookie: jar(start) } });
    expect(String(res.headers["location"]).startsWith(`${LOCAL}#session=`)).toBe(true);
  });

  it("refuses anything not on the allowlist, byte for byte, and sets no cookie", async () => {
    const p = await make();
    const bad = [
      "https://evil.example.com/",
      "https://console.example.com/app", // missing trailing slash
      "https://console.example.com/app/x",
      "https://console.example.com/app/#x",
      "https://console.example.com.evil.com/app/",
      "HTTPS://console.example.com/app/",
      "javascript:alert(1)",
      "//console.example.com/app/",
      "",
    ];
    for (const u of bad) {
      const res = await p.app.inject({ method: "GET", url: `/v1/auth/login?return_to=${encodeURIComponent(u)}` });
      expect(res.statusCode, u).toBe(400);
      expect(res.headers["set-cookie"], u).toBeUndefined();
      expect(res.headers["location"], u).toBeUndefined();
    }
    const twice = await p.app.inject({ method: "GET", url: `/v1/auth/login?return_to=${encodeURIComponent(APP)}&return_to=${encodeURIComponent(LOCAL)}` });
    expect(twice.statusCode).toBe(400);
  });

  it("refuses every return_to when none is configured, and keeps the JSON flow", async () => {
    const p = await make({});
    expect((await p.app.inject({ method: "GET", url: `/v1/auth/login?return_to=${encodeURIComponent(APP)}` })).statusCode).toBe(400);
    const plain = await p.login(alice);
    expect(plain.token).toBeTruthy();
  });

  it("falls back to JSON when the return cookie names a URL that is not allowlisted (forged cookie)", async () => {
    const p = await make();
    const start = await p.app.inject({ method: "GET", url: "/v1/auth/login" });
    const callback = await p.idp.browse(start.headers["location"] as string);
    const forged = `${cookieOf(start)}; omnisync_return=${encodeURIComponent("https://evil.example.com/")}`;
    const res = await p.app.inject({ method: "GET", url: callback, headers: { cookie: forged } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["location"]).toBeUndefined();
    expect(res.json<{ sessionToken: string }>().sessionToken).toBeTruthy();
    // Garbage that does not even decode behaves the same.
    const start2 = await p.app.inject({ method: "GET", url: "/v1/auth/login" });
    const res2 = await p.app.inject({ method: "GET", url: await p.idp.browse(start2.headers["location"] as string), headers: { cookie: `${cookieOf(start2)}; omnisync_return=%E0%A4%A` } });
    expect(res2.statusCode).toBe(200);
    expect(res2.headers["location"]).toBeUndefined();
  });

  it("still binds the callback to the browser that started the login", async () => {
    const p = await make();
    const start = await p.app.inject({ method: "GET", url: `/v1/auth/login?return_to=${encodeURIComponent(APP)}` });
    const callback = await p.idp.browse(start.headers["location"] as string);
    // Another browser has the return cookie but not the state cookie.
    const res = await p.app.inject({ method: "GET", url: callback, headers: { cookie: `omnisync_return=${encodeURIComponent(APP)}` } });
    expect(res.statusCode).toBe(400);
    expect(res.headers["location"]).toBeUndefined();
  });

  it("rejects an unusable allowlist at startup", async () => {
    for (const bad of ["not a url", "http://console.example.com/", "https://u:p@console.example.com/", "https://console.example.com/#x", "ftp://localhost/"]) {
      await expect(startPlane({ returnTo: [bad] }), bad).rejects.toThrow(/returnTo/);
    }
  });
});
