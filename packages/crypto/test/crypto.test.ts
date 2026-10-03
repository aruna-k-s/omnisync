import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { bytesToHex, generateKeyPair, setEd25519Backend } from "@omnisync/protocol";
import {
  CertificateError,
  decodeCertificate,
  encodeAuthResponse,
  issueCertificate,
  newNonce,
  signEnrollmentProof,
  signerFromKeyPair,
  trustAnchors,
  verifyEnrollmentProof,
  verifyAuthResponse,
  verifyCertificate,
} from "../src/index.js";

const seed = (n: number) => new Uint8Array(32).fill(n);
const issuer = generateKeyPair(seed(100));
const other = generateKeyPair(seed(101));
const device = generateKeyPair(seed(1));
const trust = trustAnchors([issuer.publicKey]);
const T0 = 1_800_000_000_000;

const mk = (over: Partial<Parameters<typeof issueCertificate>[0]> = {}) =>
  issueCertificate(
    { subject: "user:alice@example.com", subjectPublicKey: device.publicKey, issuedAtMs: T0, notAfterMs: T0 + 86_400_000, ...over },
    signerFromKeyPair(issuer),
  );

describe("certificate", () => {
  it("issues, decodes and verifies; re-encoding is canonical", () => {
    const bytes = mk({ serial: new Uint8Array(16).fill(7) });
    const v = verifyCertificate(bytes, trust);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.certificate.subject).toBe("user:alice@example.com");
    expect(bytesToHex(v.certificate.publicKey)).toBe(bytesToHex(device.publicKey));
    expect(v.certificate.notAfterMs - v.certificate.notBeforeMs).toBe(86_400_000);
  });

  it("matches the frozen vector on both ed25519 backends", () => {
    for (const backend of ["node", "noble"] as const) {
      setEd25519Backend(backend);
      const bytes = mk({ serial: new Uint8Array(16).fill(7) });
      expect(bytesToHex(bytes)).toBe(FROZEN_CERT_HEX);
    }
    setEd25519Backend("node");
  });

  it("detects any single-bit change anywhere in the certificate", () => {
    const bytes = mk();
    fc.assert(
      fc.property(fc.integer({ min: 0, max: bytes.length * 8 - 1 }), (bit) => {
        const t = bytes.slice();
        t[bit >> 3] = (t[bit >> 3] as number) ^ (1 << (bit & 7));
        expect(verifyCertificate(t, trust).ok).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it("rejects a certificate from an untrusted issuer and one re-signed by another key", () => {
    const rogue = issueCertificate(
      { subject: "user:mallory", subjectPublicKey: device.publicKey, issuedAtMs: T0, notAfterMs: T0 + 1000 },
      signerFromKeyPair(other),
    );
    expect(verifyCertificate(rogue, trust)).toEqual({ ok: false, reason: "untrusted_issuer" });
    // Same issuer key id, wrong signing key.
    const forged = issueCertificate(
      { subject: "user:mallory", subjectPublicKey: device.publicKey, issuedAtMs: T0, notAfterMs: T0 + 1000 },
      { keyId: issuer.keyId, sign: signerFromKeyPair(other).sign },
    );
    expect(verifyCertificate(forged, trust)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses to issue or decode invalid fields", () => {
    expect(() => mk({ subject: "" })).toThrow(CertificateError);
    expect(() => mk({ subject: "a b" })).toThrow(CertificateError);
    expect(() => mk({ subject: "x".repeat(129) })).toThrow(CertificateError);
    expect(() => mk({ notAfterMs: T0 })).toThrow(/not-after/);
    expect(() => mk({ notBeforeMs: T0 - 1 })).toThrow(/not-before/);
    expect(() => mk({ subjectPublicKey: new Uint8Array(31) })).toThrow(CertificateError);
    const bytes = mk();
    expect(() => decodeCertificate(bytes.slice(0, bytes.length - 1))).toThrow(CertificateError);
    expect(() => decodeCertificate(new Uint8Array([...bytes, 0]))).toThrow(/after certificate/);
  });

  it("never throws anything but CertificateError on random bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        try {
          decodeCertificate(bytes);
        } catch (e) {
          expect(e).toBeInstanceOf(CertificateError);
        }
        expect(() => verifyCertificate(bytes, trust)).not.toThrow();
      }),
    );
  });

  it("round-trips arbitrary valid inputs", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9._:@-]{1,60}$/),
        fc.integer({ min: 0, max: 2 ** 40 }),
        fc.integer({ min: 0, max: 2 ** 20 }),
        fc.integer({ min: 1, max: 2 ** 30 }),
        (subject, issued, skew, life) => {
          const bytes = mk({ subject, issuedAtMs: issued, notBeforeMs: issued + skew, notAfterMs: issued + skew + life });
          const v = verifyCertificate(bytes, trust);
          expect(v.ok).toBe(true);
          if (v.ok) {
            expect(v.certificate.subject).toBe(subject);
            expect(v.certificate.notBeforeMs).toBe(issued + skew);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("auth proof", () => {
  const cert = mk();
  const nonce = newNonce();
  const good = () => encodeAuthResponse(cert, device.secretKey, "doc-1", nonce);

  it("accepts a proof bound to the cert, document and nonce", () => {
    const v = verifyAuthResponse(good(), "doc-1", nonce, trust);
    expect(v.ok).toBe(true);
  });

  it("rejects another document, another nonce, and a proof by a different key", () => {
    expect(verifyAuthResponse(good(), "doc-2", nonce, trust)).toEqual({ ok: false, reason: "bad_proof" });
    expect(verifyAuthResponse(good(), "doc-1", newNonce(), trust)).toEqual({ ok: false, reason: "bad_proof" });
    const thief = encodeAuthResponse(cert, other.secretKey, "doc-1", nonce);
    expect(verifyAuthResponse(thief, "doc-1", nonce, trust)).toEqual({ ok: false, reason: "bad_proof" });
  });

  it("rejects a proof replayed with a different certificate for the same key", () => {
    const cert2 = mk();
    const resp = good();
    const swapped = new Uint8Array([...resp.slice(0, 2), ...cert2, ...resp.slice(2 + cert.length)]);
    expect(verifyAuthResponse(swapped, "doc-1", nonce, trust).ok).toBe(false);
  });

  it("is total over hostile input", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 400 }), (bytes) => {
        expect(verifyAuthResponse(bytes, "doc-1", nonce, trust).ok).toBe(false);
      }),
    );
    const resp = good();
    for (let i = 0; i < resp.length; i += 7) {
      const t = resp.slice();
      t[i] = (t[i] as number) ^ 0x10;
      expect(verifyAuthResponse(t, "doc-1", nonce, trust).ok).toBe(false);
    }
  });
});

describe("enrollment proof", () => {
  it("binds the principal and the key, and only the key holder can make it", () => {
    const proof = signEnrollmentProof("p_1", device.publicKey, device.secretKey);
    expect(verifyEnrollmentProof("p_1", device.publicKey, proof)).toBe(true);
    expect(verifyEnrollmentProof("p_2", device.publicKey, proof)).toBe(false);
    expect(verifyEnrollmentProof("p_1", other.publicKey, proof)).toBe(false);
    const forged = signEnrollmentProof("p_1", device.publicKey, other.secretKey);
    expect(verifyEnrollmentProof("p_1", device.publicKey, forged)).toBe(false);
    expect(verifyEnrollmentProof("p_1", device.publicKey, new Uint8Array(3))).toBe(false);
  });
});

const FROZEN_CERT_HEX = "4f43010707070707070707070707070707070716757365723a616c696365406578616d706c652e636f6d8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c80a0f1c2b13480a0f1c2b13480d88aecb134b6fc96191abd27af1e7459bccb2d863957bb9bf7e03fd33546c02fa1b452864a4a6d5129cf1a135c0dca0fb3786e77e62c6f870b80320c897c08a317178c64d3f84497ad741c890c";
