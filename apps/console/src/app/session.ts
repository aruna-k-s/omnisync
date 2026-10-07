/** Console configuration, `config.json` next to `index.html`. Sign-in helpers live in `@omnisync/sdk/session`. */

export interface ConsoleConfig {
  /** Base URL of the control plane, no trailing slash. Empty: same origin. */
  controlPlane: string;
}

export function parseConfig(v: unknown): ConsoleConfig {
  const cp = typeof v === "object" && v !== null ? (v as { controlPlane?: unknown }).controlPlane : undefined;
  if (typeof cp !== "string") throw new Error("config.json needs a controlPlane URL");
  const trimmed = cp.replace(/\/+$/, "");
  if (trimmed !== "" && !/^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(trimmed)) throw new Error("controlPlane must be an origin such as https://cp.example.com");
  return { controlPlane: trimmed };
}
