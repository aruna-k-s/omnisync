import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/app/session.js";

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
