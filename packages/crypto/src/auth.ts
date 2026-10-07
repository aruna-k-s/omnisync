import { encodeVarint, readVarint, signDetached, verifyDetached, type MessageSigner } from "@omnisync/protocol";
import {
  certificateHash,
  concat,
  verifyCertificate,
  type Certificate,
  type IssuerResolver,
} from "./certificate.js";

/**
 * Connection authentication (spec: docs/specs/identity.md, "Handshake").
 * The gateway sends a random nonce; the client proves it holds the key a
 * certificate vouches for by signing (domain, document, nonce, certificate hash).
 */

export const NONCE_BYTES = 32;
const DOMAIN = new TextEncoder().encode("omnisync/v1/auth\0");

function proofMessage(docId: string, nonce: Uint8Array, certBytes: Uint8Array): Uint8Array {
  const doc = new TextEncoder().encode(docId);
  return concat(DOMAIN, encodeVarint(doc.length), doc, nonce, certificateHash(certBytes));
}

export function newNonce(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
}

/** Payload of an AUTH_RESPONSE frame: varint(len cert) ‖ cert ‖ proof(64). */
export function encodeAuthResponse(
  certBytes: Uint8Array,
  secretKey: Uint8Array,
  docId: string,
  nonce: Uint8Array,
): Uint8Array {
  const proof = signDetached(proofMessage(docId, nonce, certBytes), secretKey);
  return concat(encodeVarint(certBytes.length), certBytes, proof);
}

/** Same bytes as `encodeAuthResponse`, with the possession proof made by a callback (a non-extractable key). */
export async function encodeAuthResponseWith(
  certBytes: Uint8Array,
  sign: MessageSigner,
  docId: string,
  nonce: Uint8Array,
): Promise<Uint8Array> {
  const proof = await sign(proofMessage(docId, nonce, certBytes));
  if (proof.length !== 64) throw new Error("signer returned a signature of the wrong length");
  return concat(encodeVarint(certBytes.length), certBytes, proof);
}

export type AuthVerification =
  | { readonly ok: true; readonly certificate: Certificate; readonly certBytes: Uint8Array }
  | { readonly ok: false; readonly reason: "malformed" | "untrusted_issuer" | "bad_certificate" | "bad_proof" };

/** Never throws. Does not look at time or revocation: the gateway applies those. */
export function verifyAuthResponse(
  payload: Uint8Array,
  docId: string,
  nonce: Uint8Array,
  trusted: IssuerResolver,
): AuthVerification {
  let len: number, o: number;
  try {
    ({ value: len, next: o } = readVarint(payload, 0));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (len < 1 || len > 1024 || payload.length !== o + len + 64) return { ok: false, reason: "malformed" };
  const certBytes = payload.slice(o, o + len);
  const proof = payload.slice(o + len);
  const v = verifyCertificate(certBytes, trusted);
  if (!v.ok) {
    return { ok: false, reason: v.reason === "malformed" ? "malformed" : v.reason === "untrusted_issuer" ? "untrusted_issuer" : "bad_certificate" };
  }
  if (!verifyDetached(proof, proofMessage(docId, nonce, certBytes), v.certificate.publicKey)) {
    return { ok: false, reason: "bad_proof" };
  }
  return { ok: true, certificate: v.certificate, certBytes };
}

// ----- enrollment proof ----------------------------------------------------------

const ENROLL_DOMAIN = new TextEncoder().encode("omnisync/v1/enroll\0");

function enrollMessage(principalId: string, publicKey: Uint8Array): Uint8Array {
  const id = new TextEncoder().encode(principalId);
  return concat(ENROLL_DOMAIN, encodeVarint(id.length), id, publicKey);
}

/**
 * Proof that the requester holds the secret half of the key they want certified. The control
 * plane checks it before issuing, so nobody can obtain a certificate that binds their identity
 * to someone else's public key.
 */
export function signEnrollmentProof(principalId: string, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return signDetached(enrollMessage(principalId, publicKey), secretKey);
}

/** Same proof as `signEnrollmentProof`, made by a callback so the secret key can stay non-extractable. */
export async function signEnrollmentProofWith(principalId: string, publicKey: Uint8Array, sign: MessageSigner): Promise<Uint8Array> {
  const proof = await sign(enrollMessage(principalId, publicKey));
  if (proof.length !== 64) throw new Error("signer returned a signature of the wrong length");
  return proof;
}

export function verifyEnrollmentProof(principalId: string, publicKey: Uint8Array, proof: Uint8Array): boolean {
  return verifyDetached(proof, enrollMessage(principalId, publicKey), publicKey);
}
