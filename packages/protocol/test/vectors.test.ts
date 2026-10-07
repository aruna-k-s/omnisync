import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  Keyring,
  bytesToHex,
  generateKeyPair,
  hexToBytes,
  setEd25519Backend,
  signDetached,
  signUpdate,
  signUpdateWith,
  verifyUpdate,
} from "../src/index.js";

/**
 * Frozen test vectors. Any change here is a wire-format break: other
 * implementations (the open-source verifier, future native SDKs) test against
 * this file. Regenerate only with a version bump: `pnpm --filter @omnisync/protocol vectors`.
 */
interface Vector {
  name: string;
  seedHex: string;
  docId: string;
  sessionId: number;
  seq: number;
  claimedAtMs: number;
  payloadHex: string;
  publicKeyHex: string;
  keyIdHex: string;
  frameHex: string;
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("./vectors.json", import.meta.url)), "utf8"),
) as Vector[];

afterAll(() => setEd25519Backend("node"));

describe.each(["node", "noble"] as const)("test vectors (%s backend)", (backend) => {
  it("has vectors", () => expect(vectors.length).toBeGreaterThan(0));

  for (const v of vectors) {
    it(v.name, () => {
      setEd25519Backend(backend);
      const key = generateKeyPair(hexToBytes(v.seedHex));
      expect(bytesToHex(key.publicKey)).toBe(v.publicKeyHex);
      expect(bytesToHex(key.keyId)).toBe(v.keyIdHex);
      const frame = signUpdate(
        { docId: v.docId, sessionId: v.sessionId, seq: v.seq, claimedAtMs: v.claimedAtMs, payload: hexToBytes(v.payloadHex) },
        key,
      );
      expect(bytesToHex(frame)).toBe(v.frameHex);
      const ring = new Keyring();
      ring.add(key.publicKey);
      expect(verifyUpdate(hexToBytes(v.frameHex), v.docId, ring.resolve).ok).toBe(true);
    });
  }
});

describe("signing through a callback (the browser path: a key that cannot be exported)", () => {
  const PKCS8_PREFIX = hexToBytes("302e020100300506032b657004220420");

  for (const v of vectors) {
    it(`${v.name}: a callback over the same key gives the frozen frame`, async () => {
      const key = generateKeyPair(hexToBytes(v.seedHex));
      const input = { docId: v.docId, sessionId: v.sessionId, seq: v.seq, claimedAtMs: v.claimedAtMs, payload: hexToBytes(v.payloadHex) };
      const viaCallback = await signUpdateWith(input, key.keyId, (m) => signDetached(m, key.secretKey));
      expect(bytesToHex(viaCallback)).toBe(v.frameHex);
    });

    it(`${v.name}: a non-extractable WebCrypto Ed25519 key gives the frozen frame`, async () => {
      const subtle = globalThis.crypto.subtle;
      const pkcs8 = new Uint8Array([...PKCS8_PREFIX, ...hexToBytes(v.seedHex)]);
      const secret = await subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
      expect(secret.extractable).toBe(false);
      await expect(subtle.exportKey("pkcs8", secret)).rejects.toThrow();
      const key = generateKeyPair(hexToBytes(v.seedHex));
      const input = { docId: v.docId, sessionId: v.sessionId, seq: v.seq, claimedAtMs: v.claimedAtMs, payload: hexToBytes(v.payloadHex) };
      const frame = await signUpdateWith(input, key.keyId, async (m) => new Uint8Array(await subtle.sign({ name: "Ed25519" }, secret, m as BufferSource)));
      expect(bytesToHex(frame)).toBe(v.frameHex);
    });
  }

  it("refuses a signer that returns the wrong number of bytes", async () => {
    const key = generateKeyPair(new Uint8Array(32).fill(3));
    const input = { docId: "d", sessionId: 1, seq: 1, claimedAtMs: 1, payload: new Uint8Array(1) };
    await expect(signUpdateWith(input, key.keyId, () => new Uint8Array(63))).rejects.toThrow(/wrong length/);
    await expect(signUpdateWith(input, key.keyId, () => new Uint8Array(65))).rejects.toThrow(/wrong length/);
  });

  it("a signer that rejects rejects the call and produces no frame", async () => {
    const key = generateKeyPair(new Uint8Array(32).fill(3));
    const input = { docId: "d", sessionId: 1, seq: 1, claimedAtMs: 1, payload: new Uint8Array(1) };
    await expect(signUpdateWith(input, key.keyId, () => Promise.reject(new Error("key locked")))).rejects.toThrow("key locked");
  });
});
