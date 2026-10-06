import { sha256 } from "@noble/hashes/sha2.js";
import { KEY_ID_BYTES, readVarint, signDetached, verifyDetached, varintSize, writeVarint } from "@omnisync/protocol";
import type { KeyPair } from "@omnisync/protocol";
import { SERIAL_BYTES, concat } from "./certificate.js";

/**
 * Ledger entry hash and signed checkpoints (spec: docs/specs/ledger.md).
 * Every function here is pure: the store, the gateway and the offline verifier
 * must compute exactly the same bytes.
 */

export const HASH_BYTES = 32;
export const ZERO_HASH: Uint8Array = new Uint8Array(HASH_BYTES);
export const LEDGER_ENTRY_VERSION = 1;
export const CHECKPOINT_VERSION = 1;
const ENTRY_DOMAIN = new TextEncoder().encode("omnisync/v1/ledger-entry\0");
const CHECKPOINT_DOMAIN = new TextEncoder().encode("omnisync/v1/checkpoint\0");
const CHECKPOINT_MAGIC = [0x4f, 0x4b] as const;
const MAX_TENANT_BYTES = 64;
const MAX_DOC_BYTES = 256;
const MAX_CHECKPOINT_DOCS = 100_000;

export interface LedgerEntryFields {
  readonly documentId: string;
  readonly seq: number;
  /** `entryHash` of seq-1, or ZERO_HASH for seq 1. */
  readonly prevHash: Uint8Array;
  readonly receivedAtMs: number;
  /** 0 until Phase 2 encryption. */
  readonly keyEpoch: number;
  /** Absent only for unauthenticated test setups. */
  readonly certSerial?: Uint8Array | undefined;
  readonly frameHash: Uint8Array;
  readonly payloadHash: Uint8Array;
}

export const hashBytes = (bytes: Uint8Array): Uint8Array => sha256(bytes);

function u64(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError("value must be a safe non-negative integer");
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
}

function u32(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) throw new RangeError("value must fit in 32 bits");
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(varintSize(bytes.length) + bytes.length);
  const o = writeVarint(out, 0, bytes.length);
  out.set(bytes, o);
  return out;
}

function mustLength(name: string, b: Uint8Array, n: number): void {
  if (b.length !== n) throw new RangeError(`${name} must be ${n} bytes`);
}

/** The hash that chains one entry to the next. Throws RangeError on malformed fields (a programming error). */
export function entryHash(f: LedgerEntryFields): Uint8Array {
  mustLength("prevHash", f.prevHash, HASH_BYTES);
  mustLength("frameHash", f.frameHash, HASH_BYTES);
  mustLength("payloadHash", f.payloadHash, HASH_BYTES);
  if (f.certSerial !== undefined) mustLength("certSerial", f.certSerial, SERIAL_BYTES);
  const doc = new TextEncoder().encode(f.documentId);
  if (doc.length === 0) throw new RangeError("documentId must not be empty");
  return sha256(
    concat(
      ENTRY_DOMAIN,
      Uint8Array.of(LEDGER_ENTRY_VERSION),
      lengthPrefixed(doc),
      u64(f.seq),
      f.prevHash,
      u64(f.receivedAtMs),
      u32(f.keyEpoch),
      f.certSerial === undefined ? Uint8Array.of(0) : concat(Uint8Array.of(1), f.certSerial),
      f.frameHash,
      f.payloadHash,
    ),
  );
}

// ----- checkpoints -----------------------------------------------------------

export interface CheckpointHead {
  readonly documentId: string;
  readonly seq: number;
  readonly headHash: Uint8Array;
}

export interface CheckpointBody {
  /** Gapless from 1. */
  readonly n: number;
  readonly createdAtMs: number;
  /** `checkpointHash` of n-1, or ZERO_HASH for n = 1. */
  readonly prevCheckpointHash: Uint8Array;
  readonly tenant: string;
  /** Documents whose head moved since checkpoint n-1, strictly ascending by id bytes. */
  readonly heads: readonly CheckpointHead[];
}

export interface Checkpoint extends CheckpointBody {
  readonly ledgerKeyId: Uint8Array;
  readonly signature: Uint8Array;
  /** Exact bytes the signature covers (without the domain prefix). */
  readonly tbs: Uint8Array;
  /** The whole signed object. */
  readonly bytes: Uint8Array;
}

/** Anything that can sign for the ledger key: a local key today, a KMS call in Phase 2. Never the certificate issuing key. */
export interface LedgerSigner {
  readonly keyId: Uint8Array;
  sign(message: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export function ledgerSignerFromKeyPair(key: KeyPair): LedgerSigner {
  return { keyId: key.keyId, sign: (m) => signDetached(m, key.secretKey) };
}

export class CheckpointError extends Error {
  override readonly name = "CheckpointError";
  constructor(message: string) {
    super(message);
  }
}

const byteOrder = (a: Uint8Array, b: Uint8Array): number => Buffer.compare(a, b);

function encodeTbs(body: CheckpointBody, ledgerKeyId: Uint8Array): Uint8Array {
  mustLength("prevCheckpointHash", body.prevCheckpointHash, HASH_BYTES);
  mustLength("ledgerKeyId", ledgerKeyId, KEY_ID_BYTES);
  if (!Number.isSafeInteger(body.n) || body.n < 1) throw new RangeError("n must be a positive integer");
  const tenant = new TextEncoder().encode(body.tenant);
  if (tenant.length < 1 || tenant.length > MAX_TENANT_BYTES) throw new RangeError("tenant must be 1-64 bytes");
  if (body.heads.length > MAX_CHECKPOINT_DOCS) throw new RangeError("too many heads");
  const parts: Uint8Array[] = [];
  const head = new Uint8Array(3 + varintSize(body.n) + varintSize(body.createdAtMs));
  head.set(CHECKPOINT_MAGIC, 0);
  head[2] = CHECKPOINT_VERSION;
  const o = writeVarint(head, 3, body.n);
  writeVarint(head, o, body.createdAtMs);
  parts.push(head, body.prevCheckpointHash, lengthPrefixed(tenant));
  const count = new Uint8Array(varintSize(body.heads.length));
  writeVarint(count, 0, body.heads.length);
  parts.push(count);
  let last: Uint8Array | undefined;
  for (const h of body.heads) {
    const id = new TextEncoder().encode(h.documentId);
    if (id.length < 1 || id.length > MAX_DOC_BYTES) throw new RangeError("document id must be 1-256 bytes");
    if (last !== undefined && byteOrder(last, id) >= 0) throw new RangeError("heads must be strictly ascending by document id");
    last = id;
    mustLength("headHash", h.headHash, HASH_BYTES);
    const seq = new Uint8Array(varintSize(h.seq));
    writeVarint(seq, 0, h.seq);
    parts.push(lengthPrefixed(id), seq, h.headHash);
  }
  parts.push(ledgerKeyId);
  return concat(...parts);
}

/** Builds and signs a checkpoint. Async because the signer may be remote. */
export async function signCheckpoint(body: CheckpointBody, signer: LedgerSigner): Promise<Uint8Array> {
  const tbs = encodeTbs(body, signer.keyId);
  const signature = await signer.sign(concat(CHECKPOINT_DOMAIN, tbs));
  if (signature.length !== 64) throw new CheckpointError("signer returned a signature of the wrong length");
  return concat(tbs, signature);
}

/** Structural decode only: no trust. Throws CheckpointError. */
export function decodeCheckpoint(bytes: Uint8Array): Checkpoint {
  const fail = (m: string): never => {
    throw new CheckpointError(m);
  };
  if (bytes.length < 3 + 32 + 1 + 1 + 8 + 64) fail("checkpoint too short");
  if (bytes[0] !== CHECKPOINT_MAGIC[0] || bytes[1] !== CHECKPOINT_MAGIC[1]) fail("bad magic");
  if (bytes[2] !== CHECKPOINT_VERSION) fail(`unsupported checkpoint version ${bytes[2]}`);
  let o = 3;
  const varint = (): number => {
    try {
      const r = readVarint(bytes, o);
      o = r.next;
      return r.value;
    } catch (e) {
      return fail((e as Error).message);
    }
  };
  const take = (n: number): Uint8Array => {
    if (n < 0 || o + n > bytes.length) fail("checkpoint truncated");
    const out = bytes.slice(o, o + n);
    o += n;
    return out;
  };
  const text = (n: number): string => {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(take(n));
    } catch (e) {
      if (e instanceof CheckpointError) throw e;
      return fail("not UTF-8");
    }
  };
  const n = varint();
  const createdAtMs = varint();
  if (n < 1) fail("n must be at least 1");
  const prevCheckpointHash = take(HASH_BYTES);
  const tenantLen = varint();
  if (tenantLen < 1 || tenantLen > MAX_TENANT_BYTES) fail("tenant length");
  const tenant = text(tenantLen);
  const count = varint();
  if (count > MAX_CHECKPOINT_DOCS) fail("too many heads");
  const heads: CheckpointHead[] = [];
  let last: Uint8Array | undefined;
  for (let i = 0; i < count; i++) {
    const idLen = varint();
    if (idLen < 1 || idLen > MAX_DOC_BYTES) fail("document id length");
    const idBytes = take(idLen);
    if (last !== undefined && byteOrder(last, idBytes) >= 0) fail("heads not strictly ascending");
    last = idBytes;
    let documentId: string;
    try {
      documentId = new TextDecoder("utf-8", { fatal: true }).decode(idBytes);
    } catch {
      return fail("document id is not UTF-8");
    }
    const seq = varint();
    heads.push({ documentId, seq, headHash: take(HASH_BYTES) });
  }
  const ledgerKeyId = take(KEY_ID_BYTES);
  const tbs = bytes.slice(0, o);
  const signature = take(64);
  if (o !== bytes.length) fail("bytes after checkpoint");
  return { n, createdAtMs, prevCheckpointHash, tenant, heads, ledgerKeyId, signature, tbs, bytes: bytes.slice() };
}

export type CheckpointVerification =
  | { readonly ok: true; readonly checkpoint: Checkpoint }
  | { readonly ok: false; readonly reason: "malformed" | "untrusted_key" | "bad_signature" };

/** Decode, find the ledger key by id and verify the signature. Never throws. */
export function verifyCheckpoint(bytes: Uint8Array, trusted: (keyId: Uint8Array) => Uint8Array | undefined): CheckpointVerification {
  let checkpoint: Checkpoint;
  try {
    checkpoint = decodeCheckpoint(bytes);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const key = trusted(checkpoint.ledgerKeyId);
  if (key === undefined) return { ok: false, reason: "untrusted_key" };
  if (!verifyDetached(checkpoint.signature, concat(CHECKPOINT_DOMAIN, checkpoint.tbs), key)) return { ok: false, reason: "bad_signature" };
  return { ok: true, checkpoint };
}

export const checkpointHash = (bytes: Uint8Array): Uint8Array => sha256(bytes);

/** Object-store key of checkpoint n. Fixed width so listings sort. Tenant is hex so any id is a safe segment. */
export function checkpointObjectKey(tenant: string, n: number): string {
  return `checkpoints/${Buffer.from(tenant, "utf8").toString("hex")}/${String(n).padStart(12, "0")}.ckpt`;
}
