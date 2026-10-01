// Regenerates test/vectors.json. Changing the output is a wire-format break.
import { writeFileSync } from "node:fs";
import { bytesToHex, generateKeyPair, signUpdate } from "../src/index.js";

const cases = [
  { name: "empty payload", seed: 1, docId: "doc-1", sessionId: 0, seq: 0, payload: "" },
  { name: "small payload", seed: 2, docId: "workbook/q3", sessionId: 42, seq: 1, payload: "68656c6c6f" },
  { name: "multi-byte varints", seed: 3, docId: "d", sessionId: 300, seq: 2 ** 40, payload: "00ff00ff" },
  { name: "unicode doc id", seed: 4, docId: "ಬೆಂಗಳೂರು-ledger", sessionId: 1, seq: 1, payload: "01" },
];

const out = cases.map((c) => {
  const seedBytes = new Uint8Array(32).fill(c.seed);
  const key = generateKeyPair(seedBytes);
  const payload = Uint8Array.from(Buffer.from(c.payload, "hex"));
  return {
    name: c.name,
    seedHex: bytesToHex(seedBytes),
    docId: c.docId,
    sessionId: c.sessionId,
    seq: c.seq,
    payloadHex: c.payload,
    publicKeyHex: bytesToHex(key.publicKey),
    keyIdHex: bytesToHex(key.keyId),
    frameHex: bytesToHex(signUpdate({ docId: c.docId, sessionId: c.sessionId, seq: c.seq, payload }, key)),
  };
});

writeFileSync(new URL("../test/vectors.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.warn(`wrote ${out.length} vectors`);
