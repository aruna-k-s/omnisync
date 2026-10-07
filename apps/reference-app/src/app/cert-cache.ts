/** The certificate this browser keeps for a device key. It is not secret (useless without the key) but must match it. */

export interface StoredCert {
  publicKey: string;
  certificate: string;
  notAfterMs: number;
}

/** A certificate with less than this left is replaced rather than reused, so a document never opens with one about to lapse. */
export const RENEW_BEFORE_MS = 15 * 60_000;

/** The stored certificate (base64) if it belongs to this key and has more than the renewal window left; otherwise undefined. */
export function reusableCertificate(raw: string | null, publicKeyHex: string, nowMs: number): string | undefined {
  if (raw === null) return undefined;
  try {
    const s = JSON.parse(raw) as Partial<StoredCert> | null;
    if (typeof s?.certificate !== "string" || typeof s.publicKey !== "string" || typeof s.notAfterMs !== "number") return undefined;
    if (s.publicKey !== publicKeyHex) return undefined;
    return s.notAfterMs - nowMs > RENEW_BEFORE_MS ? s.certificate : undefined;
  } catch {
    return undefined;
  }
}

export const storedCert = (publicKeyHex: string, certificateB64: string, notAfterMs: number): string =>
  JSON.stringify({ publicKey: publicKeyHex, certificate: certificateB64, notAfterMs } satisfies StoredCert);
