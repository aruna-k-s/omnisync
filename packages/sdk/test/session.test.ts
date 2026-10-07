import { describe, expect, it } from "vitest";
import { loginUrl, returnToOf, sessionFromHash } from "../src/session.js";

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
  it("is the plain login URL without returnTo, whatever trailing slashes the base has", () => {
    expect(loginUrl("https://id.example.com/")).toBe("https://id.example.com/v1/auth/login");
    expect(loginUrl("https://id.example.com//")).toBe("https://id.example.com/v1/auth/login");
    expect(loginUrl("https://id.example.com", {})).toBe("https://id.example.com/v1/auth/login");
  });
  it("encodes return_to and nothing else", () => {
    expect(loginUrl("https://cp.example.com", { returnTo: "https://app.example.com/app/" })).toBe("https://cp.example.com/v1/auth/login?return_to=https%3A%2F%2Fapp.example.com%2Fapp%2F");
    expect(loginUrl("", { returnTo: "http://localhost:4200/" })).toBe("/v1/auth/login?return_to=http%3A%2F%2Flocalhost%3A4200%2F");
  });
  it("returns to this page without query or fragment", () => {
    expect(returnToOf({ origin: "http://localhost:4200", pathname: "/" })).toBe("http://localhost:4200/");
    expect(returnToOf({ origin: "https://x.example", pathname: "/console/" })).toBe("https://x.example/console/");
  });
});
