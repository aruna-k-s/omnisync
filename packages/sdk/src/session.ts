/**
 * Browser sign-in helpers for single-page apps (spec: docs/specs/admin-api.md, "Browser login"). Pure functions,
 * no DOM or network access, so they are tested without a browser and can be imported on their own
 * (`@omnisync/sdk/session`) without pulling in the engine.
 *
 * The flow: send the browser to `loginUrl(controlPlane, { returnTo })`; after the IdP the control plane redirects
 * back to `returnTo#session=<token>`; the app reads the token once with `sessionFromHash`, removes the fragment
 * from the address bar, and keeps the token in memory only.
 */

/**
 * Where to send the browser to sign in. Without `returnTo` the control plane answers the callback with JSON, which a
 * page cannot read; a single-page app passes the URL it is served from, which must be on the control plane's
 * `returnTo` allowlist exactly.
 */
export function loginUrl(controlPlaneUrl: string, opts: { returnTo?: string } = {}): string {
  const base = `${controlPlaneUrl.replace(/\/+$/, "")}/v1/auth/login`;
  return opts.returnTo === undefined ? base : `${base}?return_to=${encodeURIComponent(opts.returnTo)}`;
}

/** The URL a page should ask to be sent back to: its own origin and path, without query or fragment. */
export function returnToOf(loc: { origin: string; pathname: string }): string {
  return `${loc.origin}${loc.pathname}`;
}

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
