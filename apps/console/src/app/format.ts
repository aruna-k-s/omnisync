/** UTC, to the second, unambiguous in an audit trail. */
export function when(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

export function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export type CertState = "revoked" | "expired" | "not yet valid" | "active";

export function certState(c: { notBeforeMs: number; notAfterMs: number; revokedAtMs?: number }, nowMs: number): CertState {
  if (c.revokedAtMs !== undefined) return "revoked";
  if (nowMs >= c.notAfterMs) return "expired";
  if (nowMs < c.notBeforeMs) return "not yet valid";
  return "active";
}
