const MAX_KEY_BYTES = 1024;

/**
 * The one rule every ObjectStore applies before touching storage: a key is 1-1024 bytes of well-formed text, relative,
 * with no `..` segment, backslash or NUL. Throws with a message that names the problem and the (already hostile) key.
 */
export function assertObjectKey(key: string): void {
  const shown = JSON.stringify(key.length > 80 ? `${key.slice(0, 80)}...` : key);
  if (typeof key !== "string" || key.length === 0) throw new Error("invalid object key: empty");
  if (!(key as string & { isWellFormed(): boolean }).isWellFormed()) throw new Error(`invalid object key: not well-formed text ${shown}`);
  if (Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES) throw new Error(`invalid object key: longer than ${MAX_KEY_BYTES} bytes`);
  if (key.includes("\0") || key.includes("\\")) throw new Error(`invalid object key: control or backslash character ${shown}`);
  if (key.startsWith("/") || key.split("/").includes("..")) throw new Error(`object key escapes root: ${shown}`);
}
