import { describe, expect, it } from "vitest";
import { SECONDS_BUCKETS, pick, safely, validSeconds } from "../src/safe.js";

describe("safely", () => {
  it("runs the function", () => {
    let n = 0;
    safely(() => void n++);
    expect(n).toBe(1);
  });
  it("swallows every kind of throw", () => {
    expect(() => safely(() => { throw new Error("x"); })).not.toThrow();
    expect(() => safely(() => { throw "string"; })).not.toThrow();
    expect(() => safely(() => { throw undefined; })).not.toThrow();
  });
});

describe("pick", () => {
  const set = ["a", "b"] as const;
  it("passes values in the set", () => {
    expect(pick(set, "a")).toBe("a");
    expect(pick(set, "b")).toBe("b");
  });
  it("maps everything else to other", () => {
    for (const v of ["c", "", "A", "a ", "__proto__", "constructor", 1, undefined, null, {}, "a".repeat(10_000)]) expect(pick(set, v)).toBe("other");
  });
});

describe("validSeconds", () => {
  it("accepts zero and positive finite numbers", () => {
    for (const v of [0, 0.000001, 1, 10, 3600]) expect(validSeconds(v)).toBe(true);
  });
  it("refuses negatives, NaN, infinities and other types", () => {
    for (const v of [-0.000001, -1, Number.NaN, Infinity, -Infinity, "1" as never, undefined as never, null as never]) expect(validSeconds(v)).toBe(false);
  });
});

describe("SECONDS_BUCKETS", () => {
  it("are the documented boundaries, ascending", () => {
    expect(SECONDS_BUCKETS).toEqual([0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);
  });
});
