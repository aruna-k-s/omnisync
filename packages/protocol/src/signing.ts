import type * as NodeCryptoModule from "node:crypto";
import * as ed from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { encodeVarint } from "./varint.js";
import {
  FLAG_SIGNED,
  FrameType,
  KEY_ID_BYTES,
  decodeFrame,
  encodeFrame,
  encodeUnsignedPart,
  type DecodeOptions,
  type Frame,
} from "./frame.js";

// Enable the synchronous API; noble only ships the async one by default.
ed.hashes.sha512 = sha512;

/**
 * Ed25519 backend. On Node the native OpenSSL implementation is ~10-50x
 * faster than pure JS, which matters at the gateway where every UPDATE is
 * verified. Browsers use noble. Both are RFC 8032 deterministic, so they emit
 * identical signatures; the shared test vectors prove it.
 */
type NodeCrypto = typeof NodeCryptoModule;
type KeyObject = NodeCryptoModule.KeyObject;
const nodeCrypto: NodeCrypto | undefined = (
  globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }
).process?.getBuiltinModule?.("node:crypto") as NodeCrypto | undefined;

const PKCS8_PREFIX = ed.etc.hexToBytes("302e020100300506032b657004220420");
const SPKI_PREFIX = ed.etc.hexToBytes("302a300506032b6570032100");
// Keyed by the byte array instance: no secret material is copied into strings.
const privateKeys = new WeakMap<Uint8Array, KeyObject>();
const publicKeys = new WeakMap<Uint8Array, KeyObject>();

function nodeKey(kind: "private" | "public", raw: Uint8Array): KeyObject {
  const cache = kind === "private" ? privateKeys : publicKeys;
  let key = cache.get(raw);
  if (!key) {
    const c = nodeCrypto as NodeCrypto;
    key =
      kind === "private"
        ? c.createPrivateKey({ key: Buffer.from(ed.etc.concatBytes(PKCS8_PREFIX, raw)), format: "der", type: "pkcs8" })
        : c.createPublicKey({ key: Buffer.from(ed.etc.concatBytes(SPKI_PREFIX, raw)), format: "der", type: "spki" });
    cache.set(raw, key);
  }
  return key;
}

export type Ed25519Backend = "node" | "noble";
let backend: Ed25519Backend = nodeCrypto ? "node" : "noble";

/** Forces a backend; used by tests to prove both agree. */
export function setEd25519Backend(next: Ed25519Backend): void {
  if (next === "node" && !nodeCrypto) throw new Error("node:crypto is not available here");
  backend = next;
}

function rawSign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  if (backend === "node") {
    return new Uint8Array((nodeCrypto as NodeCrypto).sign(null, message, nodeKey("private", secretKey)));
  }
  return ed.sign(message, secretKey);
}

function rawVerify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  if (backend === "node") {
    return (nodeCrypto as NodeCrypto).verify(null, message, nodeKey("public", publicKey), signature);
  }
  return ed.verify(signature, message, publicKey, { zip215: false });
}

/**
 * Domain separation: a signature over an OmniSync update can never be valid
 * for any other protocol, frame version or document.
 */
const DOMAIN = new TextEncoder().encode("omnisync/v1/update\0");

export interface KeyPair {
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly keyId: Uint8Array;
}

/** First 8 bytes of SHA-256(publicKey). */
export function keyIdOf(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  return sha256(publicKey).slice(0, KEY_ID_BYTES);
}

/** Random key pair, or a deterministic one from a 32-byte seed (tests and vectors only). */
export function generateKeyPair(seed?: Uint8Array): KeyPair {
  const { secretKey, publicKey } = seed === undefined ? ed.keygen() : ed.keygen(seed);
  return { secretKey, publicKey, keyId: keyIdOf(publicKey) };
}

export function signedMessage(docId: string, unsignedPart: Uint8Array): Uint8Array {
  const doc = new TextEncoder().encode(docId);
  if (doc.length === 0) throw new Error("docId must not be empty");
  return ed.etc.concatBytes(DOMAIN, encodeVarint(doc.length), doc, unsignedPart);
}

export interface UpdateInput {
  readonly docId: string;
  readonly sessionId: number;
  readonly seq: number;
  /** When the edit was made on the device, ms since epoch. Signed, so it cannot be changed in transit. */
  readonly claimedAtMs: number;
  readonly payload: Uint8Array;
}

function updateBase(input: UpdateInput, keyId: Uint8Array) {
  return {
    type: FrameType.UPDATE,
    flags: FLAG_SIGNED,
    sessionId: input.sessionId,
    seq: input.seq,
    claimedAtMs: input.claimedAtMs,
    payload: input.payload,
    keyId,
  };
}

/** Builds and signs an UPDATE frame. Returns wire bytes. */
export function signUpdate(input: UpdateInput, key: KeyPair): Uint8Array {
  const base = updateBase(input, key.keyId);
  const signature = rawSign(signedMessage(input.docId, encodeUnsignedPart(base)), key.secretKey);
  return encodeFrame({ ...base, signature });
}

/** Signs a message with a key that may never leave its holder (a non-extractable WebCrypto key, a KMS). */
export type MessageSigner = (message: Uint8Array) => Uint8Array | Promise<Uint8Array>;

/**
 * Same frame as `signUpdate`, byte for byte, but the signature comes from a callback so the secret key can stay
 * inside a non-extractable key. Ed25519 is deterministic: a callback backed by the same key yields the same bytes.
 */
export async function signUpdateWith(input: UpdateInput, keyId: Uint8Array, sign: MessageSigner): Promise<Uint8Array> {
  const base = updateBase(input, keyId);
  const signature = await sign(signedMessage(input.docId, encodeUnsignedPart(base)));
  if (signature.length !== 64) throw new Error("signer returned a signature of the wrong length");
  return encodeFrame({ ...base, signature });
}

/**
 * Detached Ed25519 signature for protocol objects other than UPDATE frames
 * (certificates, AUTH proofs). Callers must prefix `message` with their own
 * domain-separation string; see packages/crypto.
 */
export function signDetached(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return rawSign(message, secretKey);
}

/** Strict verification of a detached signature. Never throws. */
export function verifyDetached(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  try {
    return rawVerify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/** Resolves a key id to a trusted public key, or undefined if unknown or revoked. */
export type KeyResolver = (keyId: Uint8Array) => Uint8Array | undefined;

export type VerifyResult =
  | { readonly ok: true; readonly frame: Frame; readonly publicKey: Uint8Array }
  | { readonly ok: false; readonly reason: "malformed" | "unknown_key" | "bad_signature" | "not_update" };

/**
 * Decodes and verifies an UPDATE frame for `docId`. Never throws on hostile
 * input; every failure is a typed result so the gateway can count and drop it.
 * Uses strict RFC 8032 verification (no ZIP-215) so signatures are not malleable.
 */
export function verifyUpdate(
  bytes: Uint8Array,
  docId: string,
  resolveKey: KeyResolver,
  opts: DecodeOptions = {},
): VerifyResult {
  let frame: Frame;
  try {
    frame = decodeFrame(bytes, opts);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (frame.type !== FrameType.UPDATE || frame.keyId === undefined || frame.signature === undefined) {
    return { ok: false, reason: "not_update" };
  }
  const publicKey = resolveKey(frame.keyId);
  if (publicKey === undefined) return { ok: false, reason: "unknown_key" };
  const unsigned = bytes.subarray(0, bytes.length - frame.signature.length);
  let valid: boolean;
  try {
    valid = rawVerify(frame.signature, signedMessage(docId, unsigned), publicKey);
  } catch {
    valid = false;
  }
  return valid ? { ok: true, frame, publicKey } : { ok: false, reason: "bad_signature" };
}

export function bytesToHex(bytes: Uint8Array): string {
  return ed.etc.bytesToHex(bytes);
}

export function hexToBytes(hex: string): Uint8Array {
  return ed.etc.hexToBytes(hex);
}
