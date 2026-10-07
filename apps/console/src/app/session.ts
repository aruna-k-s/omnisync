/**
 * The session lives in memory only. After the IdP login the control plane sends the browser back with
 * `#session=<token>`; we read it once and remove it from the address bar and history.
 */

/** Extracts the token from a location hash such as `#session=abc`. Anything else is ignored. */
export function sessionFromHash(hash: string): string | undefined {
  const m = /^#session=([A-Za-z0-9._~%-]{1,4096})$/.exec(hash);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1] as string);
  } catch {
    return undefined;
  }
}

/** The URL that starts the login. `returnTo` must be one of the control plane's allowlisted entries, exactly. */
export function loginUrl(controlPlane: string, returnTo: string): string {
  return `${controlPlane}/v1/auth/login?return_to=${encodeURIComponent(returnTo)}`;
}

/** Where the control plane should send us back: this page without query or fragment. */
export function returnToOf(loc: { origin: string; pathname: string }): string {
  return `${loc.origin}${loc.pathname}`;
}

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
