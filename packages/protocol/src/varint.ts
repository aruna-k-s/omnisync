/**
 * Unsigned LEB128 varints, limited to Number.MAX_SAFE_INTEGER so values
 * round-trip through JavaScript numbers without loss.
 */

export const MAX_VARINT_BYTES = 8; // ceil(53 / 7)

export class VarintError extends Error {
  override readonly name = "VarintError";
}

export function varintSize(value: number): number {
  assertUint(value);
  let size = 1;
  let v = value;
  while (v >= 0x80) {
    v = Math.floor(v / 128);
    size++;
  }
  return size;
}

/** Writes `value` at `offset` and returns the offset after the last byte. */
export function writeVarint(out: Uint8Array, offset: number, value: number): number {
  assertUint(value);
  let v = value;
  let i = offset;
  while (v >= 0x80) {
    out[i++] = (v % 128) | 0x80;
    v = Math.floor(v / 128);
  }
  out[i++] = v;
  return i;
}

export function encodeVarint(value: number): Uint8Array {
  const out = new Uint8Array(varintSize(value));
  writeVarint(out, 0, value);
  return out;
}

/** Reads a varint at `offset`. Rejects truncated, overlong and non-minimal encodings. */
export function readVarint(input: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < MAX_VARINT_BYTES; i++) {
    const pos = offset + i;
    if (pos >= input.length) throw new VarintError("truncated varint");
    const byte = input[pos] as number;
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) {
      if (i > 0 && byte === 0) throw new VarintError("non-minimal varint");
      if (value > Number.MAX_SAFE_INTEGER) throw new VarintError("varint exceeds safe integer range");
      return { value, next: pos + 1 };
    }
    scale *= 128;
  }
  throw new VarintError("varint too long");
}

function assertUint(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new VarintError(`varint value must be a safe non-negative integer, got ${value}`);
  }
}
