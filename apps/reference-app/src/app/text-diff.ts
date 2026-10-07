/**
 * Turns "the textarea now says X" into the smallest insert/delete the shared text understands, and moves a caret
 * through someone else's edit. Indices are UTF-16 code units, like JavaScript strings and the shared text.
 */

export interface TextChange {
  /** Where the change starts. */
  index: number;
  /** How many code units are removed there. */
  remove: number;
  /** What is inserted there. */
  insert: string;
}

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/** The minimal single change from `a` to `b`: common prefix and suffix kept, never splitting a surrogate pair. */
export function diffText(a: string, b: string): TextChange {
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  // A prefix that ends between the halves of a pair would cut the pair in two.
  if (start > 0 && isHigh(a.charCodeAt(start - 1))) start--;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  if (endA < a.length && isLow(a.charCodeAt(endA))) {
    endA++;
    endB++;
  }
  return { index: start, remove: endA - start, insert: b.slice(start, endB) };
}

/** Applies a change to a string (what the shared text will do), for tests and for checking a diff. */
export function applyChange(s: string, c: TextChange): string {
  return s.slice(0, c.index) + c.insert + s.slice(c.index + c.remove);
}

/** Where a caret at `caret` ends up after `change` happens elsewhere in the text. */
export function shiftCaret(caret: number, change: TextChange): number {
  if (caret <= change.index) return caret;
  if (caret >= change.index + change.remove) return caret + change.insert.length - change.remove;
  return change.index + change.insert.length; // inside the removed region: just after what replaced it
}
