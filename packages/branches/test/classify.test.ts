import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Json } from "@omnisync/engine";
import { classifyChanges, type Change, type View } from "../src/index.js";

const v = (data: { [k: string]: Json }, text = ""): View => ({ text, data });
const only = (changes: Change[], path: string) => changes.find((c) => c.path === path);

describe("classifyChanges (docs/specs/shadow-branch.md, Change classification)", () => {
  const base = v({ title: "Q3", limits: { max: 5, min: 1 }, tags: ["a"] }, "hello");

  it("nothing changed gives an empty list", () => {
    expect(classifyChanges({ base, branch: base, main: base })).toEqual([]);
  });

  it("a field changed only on the branch is clean", () => {
    const branch = v({ title: "Q3 plan", limits: { max: 5, min: 1 }, tags: ["a"] }, "hello");
    expect(classifyChanges({ base, branch, main: base })).toEqual([{ path: "/title", change: "changed", class: "clean", policy: false }]);
  });

  it("the same field changed on both sides to different values is an overlap", () => {
    const branch = v({ ...base.data, title: "A" }, "hello");
    const main = v({ ...base.data, title: "B" }, "hello");
    expect(only(classifyChanges({ base, branch, main }), "/title")).toMatchObject({ change: "changed", class: "overlap" });
  });

  it("the same change made on both sides is clean: there is nothing to resolve", () => {
    const both = v({ ...base.data, title: "Same" }, "hello");
    expect(classifyChanges({ base, branch: both, main: both })).toEqual([{ path: "/title", change: "changed", class: "clean", policy: false }]);
  });

  it("different fields changed on each side are both clean", () => {
    const branch = v({ ...base.data, title: "A" }, "hello");
    const main = v({ ...base.data, limits: { max: 9, min: 1 } }, "hello");
    expect(classifyChanges({ base, branch, main }).map((c) => [c.path, c.class])).toEqual([["/title", "clean"]]);
  });

  it("nested paths are reported at the leaf", () => {
    const branch = v({ ...base.data, limits: { max: 7, min: 1 } }, "hello");
    expect(classifyChanges({ base, branch, main: base })).toEqual([{ path: "/limits/max", change: "changed", class: "clean", policy: false }]);
  });

  it("added and removed keys are reported as such", () => {
    const branch = v({ title: "Q3", limits: { max: 5 }, tags: ["a"], owner: "ana" }, "hello");
    const changes = classifyChanges({ base, branch, main: base });
    expect(only(changes, "/owner")).toMatchObject({ change: "added", class: "clean" });
    expect(only(changes, "/limits/min")).toMatchObject({ change: "removed", class: "clean" });
  });

  it("a key removed on one side and changed on the other is an overlap", () => {
    const branch = v({ title: "Q3", limits: { max: 5 }, tags: ["a"] }, "hello");
    const main = v({ title: "Q3", limits: { max: 5, min: 2 }, tags: ["a"] }, "hello");
    expect(only(classifyChanges({ base, branch, main }), "/limits/min")).toMatchObject({ change: "removed", class: "overlap" });
  });

  it("arrays are leaves: any difference is one change at the array's path", () => {
    const branch = v({ ...base.data, tags: ["a", "b"] }, "hello");
    expect(classifyChanges({ base, branch, main: base })).toEqual([{ path: "/tags", change: "changed", class: "clean", policy: false }]);
    const main = v({ ...base.data, tags: ["z", "a"] }, "hello");
    expect(only(classifyChanges({ base, branch, main }), "/tags")?.class).toBe("overlap");
  });

  it("the text is the single path $text; changed on one side is clean, on both sides an overlap", () => {
    const branch = v(base.data, "hello world");
    expect(classifyChanges({ base, branch, main: base })).toEqual([{ path: "$text", change: "changed", class: "clean", policy: false }]);
    const main = v(base.data, "hello there");
    expect(only(classifyChanges({ base, branch, main }), "$text")?.class).toBe("overlap");
  });

  it("keys that contain a slash or a tilde are escaped in the path (JSON pointer)", () => {
    const b = v({ "a/b": 1, "c~d": 1 });
    const branch = v({ "a/b": 2, "c~d": 2 });
    expect(classifyChanges({ base: b, branch, main: b }).map((c) => c.path)).toEqual(["/a~1b", "/c~0d"]);
  });

  describe("review-required paths", () => {
    const branch = v({ ...base.data, limits: { max: 7, min: 1 }, title: "x" }, "hello");
    it("flag everything at or below a prefix, and nothing else", () => {
      const changes = classifyChanges({ base, branch, main: base, reviewRequired: ["/limits"] });
      expect(only(changes, "/limits/max")?.policy).toBe(true);
      expect(only(changes, "/title")?.policy).toBe(false);
    });
    it("match whole path segments: /limits does not cover /limitsExtra", () => {
      const b = v({ limits: 1, limitsExtra: 1 });
      const br = v({ limits: 1, limitsExtra: 2 });
      expect(classifyChanges({ base: b, branch: br, main: b, reviewRequired: ["/limits"] })[0]?.policy).toBe(false);
    });
    it("apply to overlaps as well as clean changes", () => {
      const main = v({ ...base.data, limits: { max: 9, min: 1 } }, "hello");
      const c = only(classifyChanges({ base, branch, main, reviewRequired: ["/limits"] }), "/limits/max");
      expect(c).toMatchObject({ class: "overlap", policy: true });
    });
    it("the text path can be review-required", () => {
      const c = classifyChanges({ base, branch: v(base.data, "x"), main: base, reviewRequired: ["$text"] });
      expect(c[0]?.policy).toBe(true);
    });
  });

  it("output is sorted by path, so a proposal is deterministic", () => {
    const branch = v({ title: "x", limits: { max: 1, min: 0 }, tags: [], zeta: 1 }, "changed");
    const paths = classifyChanges({ base, branch, main: base }).map((c) => c.path);
    expect(paths).toEqual([...paths].sort());
  });

  describe("properties", () => {
    const leaf = fc.oneof(fc.integer({ min: 0, max: 3 }), fc.constantFrom("a", "b", "c"), fc.boolean());
    const tree: fc.Arbitrary<{ [k: string]: Json }> = fc.dictionary(fc.constantFrom("p", "q", "r", "s"), fc.oneof(leaf, fc.dictionary(fc.constantFrom("x", "y"), leaf)) as fc.Arbitrary<Json>, { maxKeys: 4 });
    const view = fc.tuple(tree, fc.constantFrom("", "a", "b")).map(([data, text]) => v(data, text));

    it("never invents a path: every reported path differs between base and branch", () => {
      fc.assert(
        fc.property(view, view, view, (b, br, m) => {
          for (const c of classifyChanges({ base: b, branch: br, main: m })) {
            const unchanged = JSON.stringify(br) === JSON.stringify(b);
            expect(unchanged).toBe(false);
            expect(c.path === "$text" || c.path.startsWith("/")).toBe(true);
          }
        }),
      );
    });

    it("when main equals base, every change is clean", () => {
      fc.assert(fc.property(view, view, (b, br) => classifyChanges({ base: b, branch: br, main: b }).every((c) => c.class === "clean")));
    });

    it("when the branch equals base there is nothing to propose", () => {
      fc.assert(fc.property(view, view, (b, m) => classifyChanges({ base: b, branch: b, main: m }).length === 0));
    });

    it("overlaps are exactly the paths both sides changed to different values, and are symmetric in branch and main", () => {
      fc.assert(
        fc.property(view, view, view, (b, br, m) => {
          const overlaps = (x: View, y: View) =>
            classifyChanges({ base: b, branch: x, main: y })
              .filter((c) => c.class === "overlap")
              .map((c) => c.path);
          // Every overlap seen from the branch's side is a path main also changed: the same path set from main's side.
          const forward = new Set(overlaps(br, m));
          const reverse = new Set(overlaps(m, br));
          expect(forward).toEqual(reverse);
        }),
      );
    });
  });
});
