import { sha256 } from "@noble/hashes/sha2.js";
import { KEY_ID_BYTES, bytesToHex, keyIdOf, readVarint, signDetached, verifyDetached, writeVarint, varintSize } from "@omnisync/protocol";
import type { KeyPair } from "@omnisync/protocol";

/**
 * Session certificate (spec: docs/specs/identity.md). Canonical binary form:
 *
 * | "OC" 2B | version 1B | serial 16B | subject varint-len + utf8 | subject key 32B |
 * | issued-at varint | not-before varint | not-after varint | issuer key id 8B | signature 64B |
 *
 * The signature covers a domain string plus every byte before it.
 */

export const CERT_VERSION = 1;
export const SERIAL_BYTES = 16;
export const MAX_SUBJECT_BYTES = 128;
const MAGIC = [0x4f, 0x43] as const;
const DOMAIN = new TextEncoder().encode("omnisync/v1/cert\0");
const SUBJECT = /^[A-Za-z0-9._:@-]+$/;

export type CertificateErrorCode =
  | "bad_magic"
  | "bad_version"
  | "truncated"
  | "trailing_bytes"
  | "bad_subject"
  | "bad_window"
  | "bad_field";

export class CertificateError extends Error {
  override readonly name = "CertificateError";
  constructor(
    readonly code: CertificateErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface Certificate {
  readonly serial: Uint8Array;
  readonly subject: string;
  readonly publicKey: Uint8Array;
  readonly issuedAtMs: number;
  readonly notBeforeMs: number;
  readonly notAfterMs: number;
  readonly issuerKeyId: Uint8Array;
  readonly signature: Uint8Array;
  /** Exact bytes the signature covers (without the domain prefix). */
  readonly tbs: Uint8Array;
}

/** Anything that can sign for the issuer: a local key today, a KMS call later. */
export interface CertificateSigner {
  readonly keyId: Uint8Array;
  sign(message: Uint8Array): Uint8Array;
}

export function signerFromKeyPair(key: KeyPair): CertificateSigner {
  return { keyId: key.keyId, sign: (m) => signDetached(m, key.secretKey) };
}

export interface CertificateInput {
  readonly subject: string;
  readonly subjectPublicKey: Uint8Array;
  readonly issuedAtMs: number;
  readonly notBeforeMs?: number;
  readonly notAfterMs: number;
  /** Random by default. Tests pass a fixed value. */
  readonly serial?: Uint8Array;
}

export function issueCertificate(input: CertificateInput, issuer: CertificateSigner): Uint8Array {
  const notBeforeMs = input.notBeforeMs ?? input.issuedAtMs;
  const serial = input.serial ?? globalThis.crypto.getRandomValues(new Uint8Array(SERIAL_BYTES));
  validateFields(serial, input.subject, input.subjectPublicKey, input.issuedAtMs, notBeforeMs, input.notAfterMs, issuer.keyId);
  const subject = new TextEncoder().encode(input.subject);
  const size =
    3 + SERIAL_BYTES + varintSize(subject.length) + subject.length + 32 +
    varintSize(input.issuedAtMs) + varintSize(notBeforeMs) + varintSize(input.notAfterMs) + KEY_ID_BYTES;
  const tbs = new Uint8Array(size);
  tbs.set(MAGIC, 0);
  tbs[2] = CERT_VERSION;
  let o = 3;
  tbs.set(serial, o);
  o += SERIAL_BYTES;
  o = writeVarint(tbs, o, subject.length);
  tbs.set(subject, o);
  o += subject.length;
  tbs.set(input.subjectPublicKey, o);
  o += 32;
  o = writeVarint(tbs, o, input.issuedAtMs);
  o = writeVarint(tbs, o, notBeforeMs);
  o = writeVarint(tbs, o, input.notAfterMs);
  tbs.set(issuer.keyId, o);
  const signature = issuer.sign(concat(DOMAIN, tbs));
  const out = new Uint8Array(tbs.length + 64);
  out.set(tbs, 0);
  out.set(signature, tbs.length);
  return out;
}

/** Structural decode only: no trust, no time. Throws CertificateError. */
export function decodeCertificate(bytes: Uint8Array): Certificate {
  if (bytes.length < 3 + 64) throw new CertificateError("truncated", "certificate too short");
  if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1]) throw new CertificateError("bad_magic", "bad magic");
  if (bytes[2] !== CERT_VERSION) throw new CertificateError("bad_version", `unsupported certificate version ${bytes[2]}`);
  let o = 3;
  const need = (n: number) => {
    if (o + n > bytes.length) throw new CertificateError("truncated", "certificate truncated");
  };
  const varint = (): number => {
    try {
      const r = readVarint(bytes, o);
      o = r.next;
      return r.value;
    } catch (e) {
      throw new CertificateError("bad_field", (e as Error).message);
    }
  };
  need(SERIAL_BYTES);
  const serial = bytes.slice(o, o + SERIAL_BYTES);
  o += SERIAL_BYTES;
  const subjectLen = varint();
  if (subjectLen < 1 || subjectLen > MAX_SUBJECT_BYTES) throw new CertificateError("bad_subject", "subject length");
  need(subjectLen);
  let subject: string;
  try {
    subject = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(o, o + subjectLen));
  } catch {
    throw new CertificateError("bad_subject", "subject is not UTF-8");
  }
  o += subjectLen;
  need(32);
  const publicKey = bytes.slice(o, o + 32);
  o += 32;
  const issuedAtMs = varint();
  const notBeforeMs = varint();
  const notAfterMs = varint();
  need(KEY_ID_BYTES + 64);
  const issuerKeyId = bytes.slice(o, o + KEY_ID_BYTES);
  o += KEY_ID_BYTES;
  const tbs = bytes.slice(0, o);
  const signature = bytes.slice(o, o + 64);
  o += 64;
  if (o !== bytes.length) throw new CertificateError("trailing_bytes", "bytes after certificate");
  validateFields(serial, subject, publicKey, issuedAtMs, notBeforeMs, notAfterMs, issuerKeyId);
  return { serial, subject, publicKey, issuedAtMs, notBeforeMs, notAfterMs, issuerKeyId, signature, tbs };
}

export type CertificateVerification =
  | { readonly ok: true; readonly certificate: Certificate }
  | { readonly ok: false; readonly reason: "malformed" | "untrusted_issuer" | "bad_signature" };

/** Resolves an issuer key id to a trusted issuer public key. */
export type IssuerResolver = (keyId: Uint8Array) => Uint8Array | undefined;

/**
 * Decode, check the issuer is trusted and verify its signature. Never throws.
 * Time and revocation are the caller's decision (they depend on a clock and a store).
 */
export function verifyCertificate(bytes: Uint8Array, trusted: IssuerResolver): CertificateVerification {
  let certificate: Certificate;
  try {
    certificate = decodeCertificate(bytes);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const issuerKey = trusted(certificate.issuerKeyId);
  if (issuerKey === undefined) return { ok: false, reason: "untrusted_issuer" };
  if (!verifyDetached(certificate.signature, concat(DOMAIN, certificate.tbs), issuerKey)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true, certificate };
}

/** Key id (as used in UPDATE frames) of the key a certificate vouches for. */
export function certificateKeyId(cert: Certificate): Uint8Array {
  return keyIdOf(cert.publicKey);
}

export function serialHex(serial: Uint8Array): string {
  return bytesToHex(serial);
}

export function certificateHash(bytes: Uint8Array): Uint8Array {
  return sha256(bytes);
}

/** Builds an IssuerResolver from public keys. */
export function trustAnchors(publicKeys: readonly Uint8Array[]): IssuerResolver {
  const byId = new Map(publicKeys.map((k) => [bytesToHex(keyIdOf(k)), k.slice()]));
  return (keyId) => byId.get(bytesToHex(keyId));
}

function validateFields(
  serial: Uint8Array,
  subject: string,
  publicKey: Uint8Array,
  issuedAtMs: number,
  notBeforeMs: number,
  notAfterMs: number,
  issuerKeyId: Uint8Array,
): void {
  if (serial.length !== SERIAL_BYTES) throw new CertificateError("bad_field", "serial must be 16 bytes");
  if (publicKey.length !== 32) throw new CertificateError("bad_field", "subject key must be 32 bytes");
  if (issuerKeyId.length !== KEY_ID_BYTES) throw new CertificateError("bad_field", "issuer key id must be 8 bytes");
  const len = new TextEncoder().encode(subject).length;
  if (len < 1 || len > MAX_SUBJECT_BYTES || !SUBJECT.test(subject)) {
    throw new CertificateError("bad_subject", "subject must be 1-128 chars of [A-Za-z0-9._:@-]");
  }
  for (const t of [issuedAtMs, notBeforeMs, notAfterMs]) {
    if (!Number.isSafeInteger(t) || t < 0) throw new CertificateError("bad_window", "times must be safe non-negative integers");
  }
  if (notAfterMs <= notBeforeMs) throw new CertificateError("bad_window", "not-after must be after not-before");
  if (notBeforeMs < issuedAtMs) throw new CertificateError("bad_window", "not-before must not precede issue time");
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
