import { signEnrollmentProofWith } from "@omnisync/crypto";
import type { DeviceKey } from "./keys.js";

export interface EnrollOptions {
  /** Base URL of the control plane, e.g. `https://id.example.com`. */
  controlPlaneUrl: string;
  /** The session token returned by the login callback. */
  sessionToken: string;
  deviceKey: DeviceKey;
  /** The principal's id. Looked up with `GET /v1/me` when omitted. */
  principalId?: string;
  /** Requested certificate lifetime; the control plane clamps it. */
  lifetimeMs?: number;
  fetch?: typeof fetch;
}

export interface Enrollment {
  /** The signed certificate, as the gateway wants it. */
  certificate: Uint8Array;
  serial: string;
  subject: string;
  notBeforeMs: number;
  notAfterMs: number;
}

export class EnrollmentError extends Error {
  override readonly name = "EnrollmentError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const b64url = (b: Uint8Array): string => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64url = (s: string): Uint8Array => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/** Where to send the browser to sign in. The callback returns a session token for `enroll`. */
export function loginUrl(controlPlaneUrl: string): string {
  return `${controlPlaneUrl.replace(/\/+$/, "")}/v1/auth/login`;
}

/** Proves possession of the device key and receives a session certificate for it. */
export async function enroll(o: EnrollOptions): Promise<Enrollment> {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  const base = o.controlPlaneUrl.replace(/\/+$/, "");
  const auth = { authorization: `Bearer ${o.sessionToken}` };

  let principalId = o.principalId;
  if (principalId === undefined) {
    const me = await f(`${base}/v1/me`, { headers: auth });
    if (!me.ok) throw new EnrollmentError(me.status, `cannot read the signed-in user (${me.status})`);
    const body = (await me.json()) as { id?: unknown };
    if (typeof body.id !== "string") throw new EnrollmentError(me.status, "unexpected /v1/me answer");
    principalId = body.id;
  }

  const proof = await signEnrollmentProofWith(principalId, o.deviceKey.publicKey, (m) => o.deviceKey.sign(m));
  const res = await f(`${base}/v1/certificates`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ publicKey: b64url(o.deviceKey.publicKey), proof: b64url(proof), ...(o.lifetimeMs !== undefined ? { lifetimeMs: o.lifetimeMs } : {}) }),
  });
  if (!res.ok) {
    let why = "";
    try {
      why = String(((await res.json()) as { message?: unknown }).message ?? "");
    } catch {
      /* not JSON */
    }
    throw new EnrollmentError(res.status, `certificate refused (${res.status})${why ? `: ${why}` : ""}`);
  }
  const j = (await res.json()) as { certificate?: unknown; serial?: unknown; subject?: unknown; notBeforeMs?: unknown; notAfterMs?: unknown };
  if (typeof j.certificate !== "string" || typeof j.serial !== "string" || typeof j.subject !== "string" || typeof j.notBeforeMs !== "number" || typeof j.notAfterMs !== "number") {
    throw new EnrollmentError(res.status, "unexpected certificate answer");
  }
  return { certificate: fromB64url(j.certificate), serial: j.serial, subject: j.subject, notBeforeMs: j.notBeforeMs, notAfterMs: j.notAfterMs };
}
