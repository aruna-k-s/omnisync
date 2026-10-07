/**
 * Device-code login for places without a browser to redirect (spec: docs/specs/device-login.md): a terminal, a build
 * agent, a native app. The device asks for a code, shows it, and polls; a person approves it in a browser where they are
 * already signed in; the device receives a session token once and uses it to enrol its own key. Uses only `fetch`, so it
 * runs in Node and in browsers.
 */

export interface DeviceLoginStart {
  /** Secret. Held by the device and sent only to the token endpoint. */
  deviceCode: string;
  /** What the person types or compares, `XXXX-XXXX`. */
  userCode: string;
  verificationUri: string;
  /** The same page with the code filled in; what a terminal prints as a link. */
  verificationUriComplete: string;
  expiresInS: number;
  intervalS: number;
}

export type DeviceLoginErrorCode =
  /** The control plane said no (device login off, rate limit, bad request): `status` has the HTTP status. */
  | "refused"
  | "access_denied"
  | "expired_token"
  | "aborted"
  | "network"
  /** An answer this client does not understand. Never treated as success. */
  | "unexpected";

export class DeviceLoginError extends Error {
  override readonly name = "DeviceLoginError";
  constructor(
    readonly code: DeviceLoginErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface DeviceLoginOptions {
  fetch?: typeof fetch;
}
export interface DevicePollOptions extends DeviceLoginOptions {
  /** Stops the wait and the poll. */
  signal?: AbortSignal;
  /** For tests. Resolves after `ms`, or earlier when the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

const base = (cp: string): string => `${cp.replace(/\/+$/, "")}/v1/auth/device`;
const MAX_TRANSIENT = 5;

async function send(f: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await f(url, init);
  } catch (e) {
    throw new DeviceLoginError("network", `cannot reach the control plane: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function bodyOf(res: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const j: unknown = await res.json();
    return typeof j === "object" && j !== null && !Array.isArray(j) ? (j as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function refusal(res: Response, what: string): Promise<DeviceLoginError> {
  const b = await bodyOf(res);
  const why = typeof b?.["error"] === "string" ? `: ${b["error"]}` : "";
  return new DeviceLoginError("refused", `${what} refused (${res.status})${why}`, res.status);
}

const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";
const isPos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Asks the control plane for a code. */
export async function startDeviceLogin(controlPlaneUrl: string, opts: DeviceLoginOptions & { label?: string } = {}): Promise<DeviceLoginStart> {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const res = await send(f, base(controlPlaneUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts.label === undefined ? {} : { label: opts.label }),
  });
  if (!res.ok) throw await refusal(res, "device login");
  const b = await bodyOf(res);
  if (!b || !isStr(b["deviceCode"]) || !isStr(b["userCode"]) || !isStr(b["verificationUri"]) || !isStr(b["verificationUriComplete"]) || !isPos(b["expiresInS"]) || !isPos(b["intervalS"])) {
    throw new DeviceLoginError("unexpected", "the control plane's device login answer was not understood");
  }
  return {
    deviceCode: b["deviceCode"],
    userCode: b["userCode"],
    verificationUri: b["verificationUri"],
    verificationUriComplete: b["verificationUriComplete"],
    expiresInS: b["expiresInS"],
    intervalS: b["intervalS"],
  };
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * Waits for the person to approve, polling at the server's rhythm. Returns the session token (use it to enrol, then drop
 * it). Throws `DeviceLoginError`: `access_denied` (they said no), `expired_token` (too slow), `aborted`, `network` (five
 * failures in a row), `unexpected`.
 */
export async function pollDeviceLogin(controlPlaneUrl: string, start: DeviceLoginStart, opts: DevicePollOptions = {}): Promise<{ sessionToken: string }> {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = now() + start.expiresInS * 1000;
  const url = `${base(controlPlaneUrl)}/token`;
  let intervalMs = start.intervalS * 1000;
  let waitMs = intervalMs;
  let failures = 0;
  const aborted = (): DeviceLoginError => new DeviceLoginError("aborted", "login cancelled");

  for (;;) {
    if (opts.signal?.aborted) throw aborted();
    if (now() >= deadline) throw new DeviceLoginError("expired_token", "the code expired before it was approved");
    await sleep(waitMs, opts.signal);
    if (opts.signal?.aborted) throw aborted();
    if (now() >= deadline) throw new DeviceLoginError("expired_token", "the code expired before it was approved");
    waitMs = intervalMs;

    let res: Response;
    try {
      res = await send(f, url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceCode: start.deviceCode }), ...(opts.signal ? { signal: opts.signal } : {}) });
    } catch (e) {
      if (opts.signal?.aborted) throw aborted();
      if (++failures >= MAX_TRANSIENT) throw e;
      continue;
    }

    if (res.status === 200) {
      const b = await bodyOf(res);
      if (b && isStr(b["sessionToken"])) return { sessionToken: b["sessionToken"] };
      throw new DeviceLoginError("unexpected", "the control plane approved the login but sent no session");
    }
    if (res.status === 429 || res.status >= 500) {
      if (++failures >= MAX_TRANSIENT) throw await refusal(res, "polling");
      const retryAfter = Number(res.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) waitMs = Math.max(intervalMs, retryAfter * 1000);
      continue;
    }
    const b = await bodyOf(res);
    const error = b?.["error"];
    failures = 0;
    if (res.status === 400 && error === "authorization_pending") continue;
    if (res.status === 400 && error === "slow_down") {
      const said = typeof b?.["interval"] === "number" && b["interval"] > 0 ? b["interval"] * 1000 : 0;
      intervalMs = Math.max(said, intervalMs + 5000);
      waitMs = intervalMs;
      continue;
    }
    if (res.status === 400 && error === "access_denied") throw new DeviceLoginError("access_denied", "the login was denied");
    if (res.status === 400 && error === "expired_token") throw new DeviceLoginError("expired_token", "the code expired or was already used");
    if (res.status === 400 || res.status === 200) throw new DeviceLoginError("unexpected", "the control plane's answer was not understood");
    throw await refusal(res, "polling");
  }
}

export interface DeviceRequestInfo {
  label: string;
  createdAtMs: number;
  expiresAtMs: number;
  status: string;
}

/** The approving page: what is being asked, so the person can compare it with what the device shows. */
export async function describeDeviceRequest(controlPlaneUrl: string, sessionToken: string, userCode: string, opts: DeviceLoginOptions = {}): Promise<DeviceRequestInfo> {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const res = await send(f, `${base(controlPlaneUrl)}/${encodeURIComponent(userCode)}`, { headers: { authorization: `Bearer ${sessionToken}` } });
  if (!res.ok) throw await refusal(res, "lookup");
  const b = await bodyOf(res);
  if (!b || typeof b["label"] !== "string" || typeof b["createdAtMs"] !== "number" || typeof b["expiresAtMs"] !== "number" || typeof b["status"] !== "string") {
    throw new DeviceLoginError("unexpected", "the control plane's answer was not understood");
  }
  return { label: b["label"], createdAtMs: b["createdAtMs"], expiresAtMs: b["expiresAtMs"], status: b["status"] };
}

/** Approves or denies a request on behalf of the signed-in person. */
export async function decideDeviceRequest(controlPlaneUrl: string, sessionToken: string, userCode: string, decision: "approve" | "deny", opts: DeviceLoginOptions = {}): Promise<void> {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const res = await send(f, `${base(controlPlaneUrl)}/${encodeURIComponent(userCode)}/${decision}`, { method: "POST", headers: { authorization: `Bearer ${sessionToken}` } });
  if (!res.ok) throw await refusal(res, decision);
}
