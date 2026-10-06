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

// ----- ledger (week 6) ---------------------------------------------------------
import {
  CheckpointError,
  HASH_BYTES,
  ZERO_HASH,
  checkpointHash,
  decodeCheckpoint,
  entryHash,
  hashBytes,
  ledgerSignerFromKeyPair,
  signCheckpoint,
  verifyCheckpoint,
  type CheckpointBody,
  type LedgerEntryFields,
} from "../src/index.js";

const ledgerKey = generateKeyPair(seed(120));
const ledgerTrust = (id: Uint8Array) => (bytesToHex(id) === bytesToHex(ledgerKey.keyId) ? ledgerKey.publicKey : undefined);
const h = (n: number) => new Uint8Array(HASH_BYTES).fill(n);

const entry = (over: Partial<LedgerEntryFields> = {}): LedgerEntryFields => ({
  documentId: "0b6f0f0e-7d2c-4c5e-9b0a-1f2e3d4c5b6a",
  seq: 1,
  prevHash: ZERO_HASH,
  receivedAtMs: T0,
  keyEpoch: 0,
  certSerial: new Uint8Array(16).fill(7),
  frameHash: h(1),
  payloadHash: h(2),
  ...over,
});

describe("ledger entry hash", () => {
  it("matches the frozen vector", () => {
    expect(bytesToHex(entryHash(entry()))).toBe(FROZEN_ENTRY_HASH);
  });

  it("changes when any single field changes", () => {
    const base = bytesToHex(entryHash(entry()));
    const variants: Partial<LedgerEntryFields>[] = [
      { documentId: "0b6f0f0e-7d2c-4c5e-9b0a-1f2e3d4c5b6b" },
      { seq: 2 },
      { prevHash: h(9) },
      { receivedAtMs: T0 + 1 },
      { keyEpoch: 1 },
      { certSerial: new Uint8Array(16).fill(8) },
      { certSerial: undefined },
      { frameHash: h(3) },
      { payloadHash: h(4) },
    ];
    for (const v of variants) expect(bytesToHex(entryHash(entry(v)))).not.toBe(base);
  });

  it("cannot confuse a missing certificate with an all-zero serial", () => {
    expect(bytesToHex(entryHash(entry({ certSerial: undefined })))).not.toBe(bytesToHex(entryHash(entry({ certSerial: new Uint8Array(16) }))));
  });

  it("is a pure function of the fields (property)", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.integer({ min: 1, max: 2 ** 40 }),
        fc.integer({ min: 0, max: 2 ** 45 }),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        (documentId, seq, receivedAtMs, frameHash) => {
          const a = entryHash(entry({ documentId, seq, receivedAtMs, frameHash }));
          const b = entryHash(entry({ documentId, seq, receivedAtMs, frameHash: frameHash.slice() }));
          return bytesToHex(a) === bytesToHex(b) && a.length === HASH_BYTES;
        },
      ),
    );
  });

  it("rejects malformed inputs loudly", () => {
    expect(() => entryHash(entry({ prevHash: new Uint8Array(31) }))).toThrow(RangeError);
    expect(() => entryHash(entry({ documentId: "" }))).toThrow(RangeError);
    expect(() => entryHash(entry({ seq: -1 }))).toThrow(RangeError);
    expect(() => entryHash(entry({ certSerial: new Uint8Array(15) }))).toThrow(RangeError);
  });
});

describe("checkpoint", () => {
  const body = (over: Partial<CheckpointBody> = {}): CheckpointBody => ({
    n: 1,
    createdAtMs: T0,
    prevCheckpointHash: ZERO_HASH,
    tenant: "acme",
    heads: [
      { documentId: "a-doc", seq: 3, headHash: h(1) },
      { documentId: "b-doc", seq: 10, headHash: h(2) },
    ],
    ...over,
  });
  const signer = ledgerSignerFromKeyPair(ledgerKey);

  it("signs, decodes and verifies; matches the frozen vector", async () => {
    const bytes = await signCheckpoint(body(), signer);
    expect(bytesToHex(bytes)).toBe(FROZEN_CHECKPOINT_HEX);
    const v = verifyCheckpoint(bytes, ledgerTrust);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.checkpoint.heads.map((x) => x.documentId)).toEqual(["a-doc", "b-doc"]);
    expect(bytesToHex(checkpointHash(bytes))).toBe(bytesToHex(hashBytes(bytes)));
  });

  it("the issuing key cannot vouch for a checkpoint", async () => {
    const bytes = await signCheckpoint(body(), ledgerSignerFromKeyPair(issuer));
    const v = verifyCheckpoint(bytes, ledgerTrust);
    expect(v).toEqual({ ok: false, reason: "untrusted_key" });
  });

  it("any single flipped byte is rejected (property)", async () => {
    const bytes = await signCheckpoint(body(), signer);
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: bytes.length - 1 }), fc.integer({ min: 1, max: 255 }), async (i, x) => {
        const bad = bytes.slice();
        bad[i] = (bad[i] as number) ^ x;
        return !verifyCheckpoint(bad, ledgerTrust).ok;
      }),
      { numRuns: 300 },
    );
  });

  it("refuses unsorted or duplicate heads on both encode and decode", async () => {
    const heads = [
      { documentId: "b", seq: 1, headHash: h(1) },
      { documentId: "a", seq: 1, headHash: h(2) },
    ];
    await expect(signCheckpoint(body({ heads }), signer)).rejects.toThrow(RangeError);
    await expect(signCheckpoint(body({ heads: [heads[0]!, heads[0]!] }), signer)).rejects.toThrow(RangeError);
  });

  it("never throws past the boundary on garbage", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 300 }), (b) => !verifyCheckpoint(b, ledgerTrust).ok));
    expect(() => decodeCheckpoint(new Uint8Array(0))).toThrow(CheckpointError);
  });

  it("rejects a wrong-length signature from a faulty signer", async () => {
    await expect(signCheckpoint(body(), { keyId: ledgerKey.keyId, sign: () => new Uint8Array(10) })).rejects.toThrow(CheckpointError);
  });
});

const FROZEN_ENTRY_HASH = "e475a7f730be71b6ca70963be6fff69e169c0d202deba8de989a1ceb8ac59d49";
const FROZEN_CHECKPOINT_HEX =
  "4f4b010180a0f1c2b13400000000000000000000000000000000000000000000000000000000000000000461636d650205612d646f6303010101010101010101010101010101010101010101010101010101010101010105622d646f630a0202020202020202020202020202020202020202020202020202020202020202fec8eb52a189539c2c6b62871707db6c93060728561c85c66a064e2c2a5ad36b91c19f028d86ca3832c33016b0b72e7348183b07b550f0eb73b1e2674874c0e0a7e554ce3646cd06";
