import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyChange, diffText, shiftCaret } from "../src/app/text-diff.js";

describe("diffText", () => {
  it("finds the single change", () => {
    expect(diffText("hello", "hello")).toEqual({ index: 5, remove: 0, insert: "" });
    expect(diffText("", "abc")).toEqual({ index: 0, remove: 0, insert: "abc" });
    expect(diffText("abc", "")).toEqual({ index: 0, remove: 3, insert: "" });
    expect(diffText("hello world", "hello brave world")).toEqual({ index: 6, remove: 0, insert: "brave " });
    expect(diffText("hello brave world", "hello world")).toEqual({ index: 6, remove: 6, insert: "" });
    expect(diffText("abcdef", "abXef")).toEqual({ index: 2, remove: 2, insert: "X" });
    expect(diffText("aaa", "aaaa")).toEqual({ index: 3, remove: 0, insert: "a" }); // ambiguous: prefix wins
  });

  it("never splits a surrogate pair", () => {
    const smile = "\u{1F600}";
    const grin = "\u{1F601}";
    expect(diffText(`a${smile}b`, `a${grin}b`)).toEqual({ index: 1, remove: 2, insert: grin });
    expect(diffText(smile, grin)).toEqual({ index: 0, remove: 2, insert: grin });
    expect(diffText("😀", "🨀")).toEqual({ index: 0, remove: 2, insert: "🨀" });
    expect(diffText(`x${smile}`, `y${smile}`)).toEqual({ index: 0, remove: 1, insert: "y" });
    // the first and last code units of each surrogate range
    expect(diffText("\u{10FC00}", "\u{10FC01}")).toEqual({ index: 0, remove: 2, insert: "\u{10FC01}" }); // high surrogate 0xDBFF
    expect(diffText("\u{10000}", "\u{20000}")).toEqual({ index: 0, remove: 2, insert: "\u{20000}" }); // low surrogate 0xDC00
  });

  it("property: applying the diff to a gives b, and the change touches only what differs", () => {
    const text = fc.string({ unit: fc.constantFrom("a", "b", "\n", " ", "\u{1F600}", "\u{1F601}", "é"), maxLength: 12 });
    fc.assert(
      fc.property(text, text, (a, b) => {
        const c = diffText(a, b);
        expect(applyChange(a, c)).toBe(b);
        expect(c.index).toBeGreaterThanOrEqual(0);
        expect(c.index + c.remove).toBeLessThanOrEqual(a.length);
        // No lone surrogate is created or cut: the pieces around and inside the change are valid UTF-16.
        const cut = [a.slice(0, c.index), a.slice(c.index + c.remove), c.insert];
        for (const piece of cut) expect(piece.isWellFormed()).toBe(true);
        if (a === b) expect(c).toEqual({ index: a.length, remove: 0, insert: "" });
      }),
      { numRuns: 500 },
    );
  });
});

describe("shiftCaret", () => {
  const ins = (index: number, insert: string) => ({ index, remove: 0, insert });
  it("leaves a caret before or at the change, and moves one after it", () => {
    expect(shiftCaret(2, ins(5, "xyz"))).toBe(2);
    expect(shiftCaret(5, ins(5, "xyz"))).toBe(5); // typing at the caret does not push it
    expect(shiftCaret(6, ins(5, "xyz"))).toBe(9);
    expect(shiftCaret(8, { index: 2, remove: 3, insert: "" })).toBe(5);
    expect(shiftCaret(5, { index: 2, remove: 3, insert: "" })).toBe(2);
    expect(shiftCaret(8, { index: 2, remove: 3, insert: "AB" })).toBe(7);
  });
  it("puts a caret inside a replaced region after the replacement", () => {
    expect(shiftCaret(4, { index: 2, remove: 5, insert: "XY" })).toBe(4);
    expect(shiftCaret(3, { index: 2, remove: 5, insert: "" })).toBe(2);
  });
  it("property: after a remote change the caret still sits between the same characters when they survive", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 }), fc.nat(40), (a, b, k) => {
        const caret = k % (a.length + 1);
        const c = diffText(a, b);
        const moved = shiftCaret(caret, c);
        expect(moved).toBeGreaterThanOrEqual(0);
        expect(moved).toBeLessThanOrEqual(b.length);
        if (caret < c.index) expect(b.slice(0, moved)).toBe(a.slice(0, caret));
        if (caret > c.index && caret >= c.index + c.remove) expect(b.slice(moved)).toBe(a.slice(caret)); // typing exactly at the caret does not push it
      }),
      { numRuns: 500 },
    );
  });
});
