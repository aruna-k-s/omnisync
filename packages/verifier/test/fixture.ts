import {
  ZERO_HASH,
  checkpointHash,
  entryHash,
  hashBytes,
  issueCertificate,
  ledgerSignerFromKeyPair,
  signCheckpoint,
  signerFromKeyPair,
  type CheckpointHead,
} from "@omnisync/crypto";
import { bytesToHex, generateKeyPair, signUpdate, type KeyPair } from "@omnisync/protocol";
import { encodeRecord, type EntryRecord, type ExportRecord } from "../src/index.js";

export const T0 = 1_800_000_000_000;
export const HOUR = 3_600_000;
const seed = (n: number) => new Uint8Array(32).fill(n);
export const issuer = generateKeyPair(seed(200));
export const ledger = generateKeyPair(seed(201));
export const stranger = generateKeyPair(seed(202));
export const trust = { issuers: [issuer.publicKey], ledgerKeys: [ledger.publicKey] };

export interface User {
  readonly key: KeyPair;
  readonly serial: Uint8Array;
  readonly certificate: Uint8Array;
  readonly notBeforeMs: number;
  readonly notAfterMs: number;
}

/**
 * Builds a ledger the way the real writer does, but independently: it uses only the crypto package,
 * so it cross-checks the store's chaining rather than reusing it.
 */
export class Fixture {
  readonly users: User[] = [];
  readonly entries: EntryRecord[] = [];
  readonly checkpoints: Uint8Array[] = [];
  #heads = new Map<string, { seq: number; hash: Uint8Array; covered: number }>();
  #clientSeq = new Map<string, number>();
  #cp = 0;
  #prevCp: Uint8Array = ZERO_HASH;
  tenant = "acme";
  now = T0 + HOUR;

  addUser(n: number, over: { notBeforeMs?: number; notAfterMs?: number; issuerKey?: KeyPair } = {}): User {
    const key = generateKeyPair(seed(10 + n));
    const serial = new Uint8Array(16).fill(n);
    const notBeforeMs = over.notBeforeMs ?? T0;
    const notAfterMs = over.notAfterMs ?? T0 + 12 * HOUR;
    const certificate = issueCertificate(
      { subject: `user:u${n}`, subjectPublicKey: key.publicKey, issuedAtMs: notBeforeMs, notBeforeMs, notAfterMs, serial },
      signerFromKeyPair(over.issuerKey ?? issuer),
    );
    const u = { key, serial, certificate, notBeforeMs, notAfterMs };
    this.users.push(u);
    return u;
  }

  append(
    doc: string,
    user: User,
    opts: {
      payload?: Uint8Array;
      claimedAtMs?: number;
      receivedAtMs?: number;
      /** Sign for a different document, so the signature is valid but not for this one. */
      signForDoc?: string;
      /** Sign with another key while attributing the entry to `user`'s certificate. */
      signWith?: KeyPair;
      /** Record a payload hash that does not match the payload (the chain itself stays consistent). */
      payloadHash?: Uint8Array;
    } = {},
  ): EntryRecord {
    const head = this.#heads.get(doc);
    const seq = (head?.seq ?? 0) + 1;
    const k = `${doc}:${bytesToHex(user.serial)}`;
    const clientSeq = (this.#clientSeq.get(k) ?? 0) + 1;
    this.#clientSeq.set(k, clientSeq);
    const payload = opts.payload ?? new Uint8Array([seq & 0xff, 7, 7]);
    const receivedAtMs = opts.receivedAtMs ?? (this.now += 1000);
    const frame = signUpdate({ docId: opts.signForDoc ?? doc, sessionId: 1, seq: clientSeq, claimedAtMs: opts.claimedAtMs ?? receivedAtMs - 500, payload }, opts.signWith ?? user.key);
    const prevHash = head?.hash ?? ZERO_HASH;
    const frameHash = hashBytes(frame);
    const payloadHash = opts.payloadHash ?? hashBytes(payload);
    const hash = entryHash({ documentId: doc, seq, prevHash, receivedAtMs, keyEpoch: 0, certSerial: user.serial, frameHash, payloadHash });
    const e: EntryRecord = { t: "entry", doc, seq, receivedAtMs, certSerial: user.serial, keyEpoch: 0, prevHash, entryHash: hash, frameHash, payloadHash, frame };
    this.entries.push(e);
    this.#heads.set(doc, { seq, hash, covered: head?.covered ?? 0 });
    return e;
  }

  /** Signs a checkpoint over every document that moved since the last one. Returns its bytes, or undefined if nothing moved. */
  async checkpoint(signer = ledgerSignerFromKeyPair(ledger), createdAtMs = this.now, all = false): Promise<Uint8Array | undefined> {
    const moved: CheckpointHead[] = [];
    for (const [documentId, h] of [...this.#heads.entries()].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      if (all || h.seq > h.covered) moved.push({ documentId, seq: h.seq, headHash: h.hash });
    }
    if (moved.length === 0) return undefined;
    const bytes = await signCheckpoint(
      { n: ++this.#cp, createdAtMs, prevCheckpointHash: this.#prevCp, tenant: this.tenant, heads: moved },
      signer,
    );
    for (const m of moved) (this.#heads.get(m.documentId) as { covered: number }).covered = m.seq;
    this.#prevCp = checkpointHash(bytes);
    this.checkpoints.push(bytes);
    return bytes;
  }

  records(): ExportRecord[] {
    return [
      { t: "meta", version: 1, tenant: this.tenant, exportedAtMs: this.now + 10 },
      ...this.users.map((u): ExportRecord => ({ t: "cert", serial: u.serial, certificate: u.certificate })),
      ...this.checkpoints.map((bytes): ExportRecord => ({ t: "checkpoint", bytes })),
      ...[...this.entries].sort((a, b) => (a.doc === b.doc ? a.seq - b.seq : Buffer.compare(Buffer.from(a.doc), Buffer.from(b.doc)))),
    ];
  }

  /** The export as the verifier receives it: JSON objects parsed back from lines. */
  lines(): string[] {
    return this.records().map(encodeRecord);
  }
}

export const parse = (lines: readonly string[]): unknown[] => lines.map((l) => JSON.parse(l) as unknown);
