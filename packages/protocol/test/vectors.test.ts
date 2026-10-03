import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  Keyring,
  bytesToHex,
  generateKeyPair,
  hexToBytes,
  setEd25519Backend,
  signUpdate,
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
