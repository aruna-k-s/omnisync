import { SignJWT, jwtVerify } from "jose";

const ALG = "HS256";
const AUDIENCE = "omnisync-control-plane";

/** Short-lived bearer token proving a completed OIDC login. Claims: principal id and expiry only. */
export async function signSession(secret: Uint8Array, principalId: string, nowMs: number, ttlMs: number): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG })
    .setSubject(principalId)
    .setAudience(AUDIENCE)
    .setIssuedAt(Math.floor(nowMs / 1000))
    .setExpirationTime(Math.floor((nowMs + ttlMs) / 1000))
    .sign(secret);
}

/** Returns the principal id, or undefined for any invalid, expired or foreign token. Never throws. */
export async function verifySession(secret: Uint8Array, token: string, nowMs: number): Promise<string | undefined> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: [ALG],
      audience: AUDIENCE,
      currentDate: new Date(nowMs),
    });
    return typeof payload.sub === "string" ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}
