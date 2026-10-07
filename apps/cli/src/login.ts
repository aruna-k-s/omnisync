import { bytesToHex, generateKeyPair, signDetached } from "@omnisync/protocol";
import { DeviceLoginError, enroll, pollDeviceLogin, startDeviceLogin, type DeviceKey } from "@omnisync/sdk";
import { UsageError } from "./args.js";
import { loadKey, saveKey, saveProfile, type Profile } from "./files.js";

export interface LoginOptions {
  server: string;
  gateway?: string;
  label: string;
  dir: string;
}
export interface LoginDeps {
  out(line: string): void;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
}

const isLocal = (u: URL): boolean => u.hostname === "localhost" || u.hostname === "127.0.0.1";

/** The control plane's origin without a trailing slash. https, or http on this machine; no credentials, path, query or fragment. */
export function checkServer(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UsageError(`"${raw}" is not a web address`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal(u))) throw new UsageError("the server must be an https address (http is allowed only for localhost)");
  if (u.username || u.password) throw new UsageError("the server address must not contain a user name or password");
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || raw.includes("#") || raw.includes("?")) throw new UsageError("the server address must be an origin such as https://id.example.com");
  return u.origin;
}

function checkGateway(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UsageError(`"${raw}" is not a WebSocket address`);
  }
  if (u.protocol !== "wss:" && !(u.protocol === "ws:" && isLocal(u))) throw new UsageError("the gateway must be a wss:// address (ws:// is allowed only for localhost)");
  if (u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) throw new UsageError("the gateway address must be an origin such as wss://sync.example.com");
  return u.origin;
}

/** Only what a terminal can show safely: a plain http(s) link and a code made of letters. */
// The control characters are the point of this pattern: a link containing one is refused.
// eslint-disable-next-line no-control-regex
const SAFE_LINK = /^https?:\/\/[^\s\u0000-\u001f\u007f-\u009f]+$/;
const SAFE_CODE = /^[A-Z]{4}-[A-Z]{4}$/;

/**
 * Signs this machine in: asks for a code, shows it, waits for a person to approve it in their browser, then enrols the
 * device key (made once, kept in a private file) and writes the profile. The session token that the approval yields is
 * used once and never stored.
 */
export async function login(o: LoginOptions, d: LoginDeps): Promise<Profile> {
  const server = checkServer(o.server);
  const gateway = o.gateway === undefined ? undefined : checkGateway(o.gateway);
  const f = d.fetch ?? globalThis.fetch.bind(globalThis);

  const start = await startDeviceLogin(server, { label: o.label, fetch: f });
  if (!SAFE_LINK.test(start.verificationUriComplete) || !SAFE_CODE.test(start.userCode)) {
    throw new DeviceLoginError("unexpected", "the server sent a login link or code that cannot be shown safely");
  }
  d.out("To finish signing in, open this link in a browser where you are signed in:");
  d.out(`  ${start.verificationUriComplete}`);
  d.out(`and check that the code shown there is:  ${start.userCode}`);
  d.out(`Waiting for approval (the code expires in ${Math.round(start.expiresInS / 60)} minutes)...`);

  const { sessionToken } = await pollDeviceLogin(server, start, {
    fetch: f,
    ...(d.sleep ? { sleep: d.sleep } : {}),
    ...(d.now ? { now: d.now } : {}),
    ...(d.signal ? { signal: d.signal } : {}),
  });

  const me = await f(`${server}/v1/me`, { headers: { authorization: `Bearer ${sessionToken}` } });
  const who = (await me.json().catch(() => undefined)) as { id?: unknown; email?: unknown } | undefined;
  if (!me.ok || typeof who?.id !== "string") throw new Error(`could not read the signed-in user (${me.status})`);

  let pair = await loadKey(o.dir);
  if (!pair) {
    pair = generateKeyPair();
    await saveKey(o.dir, pair);
  }
  const secret = pair.secretKey;
  const key: DeviceKey = {
    keyId: pair.keyId,
    publicKey: pair.publicKey,
    extractable: true,
    sign: (message) => Promise.resolve(signDetached(message, secret)),
  };
  const e = await enroll({ controlPlaneUrl: server, sessionToken, deviceKey: key, principalId: who.id, fetch: f });

  const profile: Profile = {
    server,
    ...(gateway ? { gateway } : {}),
    principalId: who.id,
    email: typeof who.email === "string" ? who.email : "",
    keyId: bytesToHex(pair.keyId),
    serial: e.serial,
    notAfterMs: e.notAfterMs,
    certificate: Buffer.from(e.certificate).toString("base64url"),
  };
  await saveProfile(o.dir, profile);
  return profile;
}

/** What `whoami` prints, and whether the machine is usable right now. */
export function whoami(p: Profile | undefined, nowMs: number): { ok: boolean; lines: string[] } {
  if (!p) return { ok: false, lines: ["not signed in: run \"omnisync-cli login\""] };
  const lines = [
    `signed in as ${p.email || p.principalId} (${p.principalId})`,
    `server:      ${p.server}`,
    ...(p.gateway ? [`gateway:     ${p.gateway}`] : []),
    `certificate: ${p.serial}`,
    `expires:     ${new Date(p.notAfterMs).toISOString()}`,
  ];
  if (p.notAfterMs <= nowMs) return { ok: false, lines: [...lines, "the certificate has expired: run \"omnisync-cli login\" again"] };
  return { ok: true, lines };
}
