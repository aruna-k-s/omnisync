/** Deterministic PRNG so every run replays the same traces. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type TypingOp = { kind: "insert"; index: number; text: string } | { kind: "delete"; index: number };

/** The typing trace of the engine bench: mostly appends near a moving cursor, about 10% deletions, an occasional jump. */
export function* typingOps(n: number, seed: number): Generator<TypingOp> {
  const rand = rng(seed);
  let cursor = 0;
  let len = 0;
  for (let i = 0; i < n; i++) {
    if (rand() < 0.05) cursor = Math.floor(rand() * (len + 1));
    cursor = Math.min(cursor, len);
    if (rand() < 0.1 && cursor > 0) {
      yield { kind: "delete", index: cursor - 1 };
      cursor--;
      len--;
    } else {
      yield { kind: "insert", index: cursor, text: String.fromCharCode(97 + Math.floor(rand() * 26)) };
      cursor++;
      len++;
    }
  }
}

/** Length of the text a trace leaves behind. */
export function traceLength(n: number, seed: number): number {
  let len = 0;
  for (const op of typingOps(n, seed)) len += op.kind === "insert" ? 1 : -1;
  return len;
}
