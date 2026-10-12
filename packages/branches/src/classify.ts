import type { Json } from "@omnisync/engine";

/** What the classifier reads of a document: its text and its data tree, as `getText()` and `getData()` return them. */
export interface View {
  readonly text: string;
  readonly data: { readonly [key: string]: Json };
}

export type ChangeKind = "added" | "removed" | "changed";
export type ChangeClass = "clean" | "overlap";

export interface Change {
  /** JSON pointer into the data tree (`/limits/max`), or `$text` for the document text. */
  readonly path: string;
  readonly change: ChangeKind;
  readonly class: ChangeClass;
  /** The path is at or below a review-required prefix: a second approver is needed. */
  readonly policy: boolean;
}

export const TEXT_PATH = "$text";

export interface ClassifyInput {
  /** Main as it was when the branch was forked. */
  readonly base: View;
  /** The branch now. */
  readonly branch: View;
  /** Main now. */
  readonly main: View;
  /** Paths (JSON pointers, or `$text`) whose changes need a second approver, together with everything below them. */
  readonly reviewRequired?: readonly string[];
}

const escapeKey = (k: string): string => k.replace(/~/g, "~0").replace(/\//g, "~1");

/** Stable text form of a value, with object keys sorted, so equality does not depend on key order. */
function canon(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(v[k] as Json)}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * Every leaf of the data tree by path. Objects are walked; arrays and empty objects are leaves, because the position of an
 * item in an array is not stable when both sides insert (docs/specs/shadow-branch.md, Change classification).
 */
function leaves(view: View): Map<string, Json> {
  const out = new Map<string, Json>();
  if (view.text !== "") out.set(TEXT_PATH, view.text);
  const walk = (node: { readonly [key: string]: Json }, prefix: string): void => {
    for (const [key, value] of Object.entries(node)) {
      const path = `${prefix}/${escapeKey(key)}`;
      if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0) walk(value, path);
      else out.set(path, value);
    }
  };
  walk(view.data, "");
  return out;
}

const same = (a: Json | undefined, b: Json | undefined): boolean => (a === undefined || b === undefined ? a === b : canon(a) === canon(b));

const covers = (prefix: string, path: string): boolean => path === prefix || path.startsWith(`${prefix}/`);

/**
 * Compares what the branch changed since the fork with what main did. A path the branch changed is an overlap when main
 * also changed it, to something other than what the branch made; otherwise it is clean. Output is sorted by path.
 */
export function classifyChanges(input: ClassifyInput): Change[] {
  const base = leaves(input.base);
  const branch = leaves(input.branch);
  const main = leaves(input.main);
  const review = input.reviewRequired ?? [];
  const out: Change[] = [];
  for (const path of new Set([...base.keys(), ...branch.keys()])) {
    const was = base.get(path);
    const now = branch.get(path);
    if (same(was, now)) continue;
    const there = main.get(path);
    const mainChanged = !same(was, there);
    out.push({
      path,
      change: was === undefined ? "added" : now === undefined ? "removed" : "changed",
      class: mainChanged && !same(now, there) ? "overlap" : "clean",
      policy: review.some((p) => covers(p, path)),
    });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
