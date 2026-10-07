import { describe, expect, it } from "vitest";
import { loginUrl, parseConfig, returnToOf, sessionFromHash } from "../src/app/session.js";

describe("session fragment", () => {
  it("reads exactly #session=<token>", () => {
    expect(sessionFromHash("#session=abc.def-ghi_1~2")).toBe("abc.def-ghi_1~2");
    expect(sessionFromHash("#session=a%2Bb")).toBe("a+b");
  });
  it("ignores everything else", () => {
    for (const h of ["", "#", "#session=", "#session", "session=abc", "#x=1&session=abc", "#session=abc&x=1", "#session=a b", "#session=%E0%A4%A", "#SESSION=abc", "x#session=abc", " #session=abc", "?session=abc", "#session=" + "a".repeat(4097)]) {
      expect(sessionFromHash(h), h).toBeUndefined();
    }
    expect(sessionFromHash("#session=" + "a".repeat(4096))).toBe("a".repeat(4096));
  });
});

describe("login url", () => {
  it("encodes return_to and nothing else", () => {
    expect(loginUrl("https://cp.example.com", "https://console.example.com/app/")).toBe("https://cp.example.com/v1/auth/login?return_to=https%3A%2F%2Fconsole.example.com%2Fapp%2F");
    expect(loginUrl("", "http://localhost:4200/")).toBe("/v1/auth/login?return_to=http%3A%2F%2Flocalhost%3A4200%2F");
  });
  it("returns to this page without query or fragment", () => {
    expect(returnToOf({ origin: "http://localhost:4200", pathname: "/" })).toBe("http://localhost:4200/");
    expect(returnToOf({ origin: "https://x.example", pathname: "/console/" })).toBe("https://x.example/console/");
  });
});

describe("config", () => {
  it("accepts an origin, with or without trailing slash, or empty for same origin", () => {
    expect(parseConfig({ controlPlane: "https://cp.example.com" })).toEqual({ controlPlane: "https://cp.example.com" });
    expect(parseConfig({ controlPlane: "https://cp.example.com/" })).toEqual({ controlPlane: "https://cp.example.com" });
    expect(parseConfig({ controlPlane: "http://localhost:8081" })).toEqual({ controlPlane: "http://localhost:8081" });
    expect(parseConfig({ controlPlane: "" })).toEqual({ controlPlane: "" });
  });
  it("rejects anything that could redirect requests elsewhere", () => {
    for (const v of [undefined, null, {}, { controlPlane: 5 }, { controlPlane: "ftp://x" }, { controlPlane: "https://cp.example.com/path" }, { controlPlane: "https://u:p@cp.example.com" }, { controlPlane: "javascript:1" }, { controlPlane: "//evil.example" }, { controlPlane: "https://a b" }]) {
      expect(() => parseConfig(v), JSON.stringify(v)).toThrow();
    }
  });
});
