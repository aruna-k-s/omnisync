import {
  ZERO_HASH,
  checkpointHash,
  entryHash,
  hashBytes,
  verifyCertificate,
  verifyCheckpoint,
  type Certificate,
} from "@omnisync/crypto";
import { bytesToHex, decodeFrame, keyIdOf, verifyUpdate, type Frame } from "@omnisync/protocol";
import { EXPORT_VERSION, parseRecord, type EntryRecord } from "./records.js";

/**
 * Offline ledger verification (spec: docs/specs/ledger.md). Pure: it reads records and
 * public keys, never a database or a network. Memory is proportional to the number of
 * documents and checkpointed heads, not to the number of entries.
 */

export type ViolationCode =
  | "export_malformed"
  | "export_order"
  | "export_version"
  | "entry_hash_mismatch"
  | "chain_gap"
  | "chain_break"
  | "frame_hash_mismatch"
  | "payload_hash_mismatch"
  | "frame_malformed"
  | "frame_erased"
  | "replay"
  | "cert_missing"
  | "cert_untrusted"
  | "cert_malformed"
  | "cert_key_mismatch"
  | "bad_signature"
  | "cert_window"
  | "claimed_window"
  | "claimed_in_future"
  | "checkpoint_signature"
  | "tenant_mismatch"
  | "checkpoint_tenant"
  | "checkpoint_gap"
  | "checkpoint_chain"
  | "checkpoint_time"
  | "checkpoint_regress"
  | "checkpoint_head_mismatch"
  | "received_after_checkpoint"
  | "truncated"
  | "locked_mismatch"
  | "locked_missing"
  | "locked_extra";

export interface Violation {
  readonly code: ViolationCode;
  readonly message: string;
  readonly documentId?: string;
  readonly seq?: number;
  readonly n?: number;
}

export interface TrustInputs {
  /** Public keys of certificate issuers. */
  readonly issuers: readonly Uint8Array[];
  /** Public keys of the ledger (checkpoint) signing key. Never the issuing key. */
  readonly ledgerKeys: readonly Uint8Array[];
  /** Upload-only grace after a certificate expires. Default 72 h. */
  readonly graceMs?: number;
  /** Tolerated device clock lead. Default 5 min. */
  readonly maxClockSkewMs?: number;
  /** The tenant the caller expects. The export's own tenant field is attacker-controlled; this is not. */
  readonly tenant?: string;
}

export interface VerifyOptions {
  /** Checkpoint objects fetched from the locked bucket, keyed by n. */
  readonly locked?: ReadonlyMap<number, Uint8Array>;
  /** Cap on stored violations; the total is always counted. Default 1,000. */
  readonly maxViolations?: number;
  /** Cap on stored warnings; the total is always counted. Default 1,000. */
  readonly maxWarnings?: number;
  /**
   * Accept entries whose frame was erased (hashes still verify, but the signature cannot be checked).
   * Off by default: an export with stripped frames must not look the same as a complete one.
   */
  readonly allowErased?: boolean;
}

export interface Report {
  /** No violations: the export is internally consistent and every signature, certificate and checkpoint checks out. */
  readonly ok: boolean;
  /**
   * The export was compared with checkpoint copies from the locked bucket and all of them matched, and at least one
   * checkpoint exists. Without this, `ok` only says the export is consistent with itself and with the ledger key:
   * someone who holds the database and the ledger key could have rewritten both.
   */
  readonly anchored: boolean;
  /** Locked checkpoint copies that were compared. */
  readonly lockedChecked: number;
  readonly tenant?: string;
  readonly exportedAtMs?: number;
  readonly counts: {
    readonly documents: number;
    readonly entries: number;
    readonly certificates: number;
    readonly checkpoints: number;
    /** Entries whose frame bytes were removed but whose hashes still verify. */
    readonly erased: number;
    /** Entries newer than the last checkpoint that covers their document: the unattested tail. */
    readonly entriesAfterLastCheckpoint: number;
  };
  readonly lastCheckpointAtMs?: number;
  readonly violations: readonly Violation[];
  /** Total violations found, including those past the stored cap. */
  readonly violationsTotal: number;
  readonly warnings: readonly string[];
  readonly warningsTotal: number;
}

type CertState = { readonly ok: true; readonly cert: Certificate } | { readonly ok: false; readonly code: ViolationCode; readonly message: string };

interface DocState {
  lastSeq: number;
  lastHash: Uint8Array;
  lastReceivedAtMs: number;
}

const DEFAULT_GRACE_MS = 72 * 3_600_000;
const DEFAULT_SKEW_MS = 5 * 60_000;
const MAX_STORED_PAYLOAD = 64 * 1024 * 1024;
const eq = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
const hex = bytesToHex;

export async function verifyLedger(
  records: AsyncIterable<unknown> | Iterable<unknown>,
  trust: TrustInputs,
  opts: VerifyOptions = {},
): Promise<Report> {
  const graceMs = trust.graceMs ?? DEFAULT_GRACE_MS;
  const skewMs = trust.maxClockSkewMs ?? DEFAULT_SKEW_MS;
  const cap = opts.maxViolations ?? 1000;
  const violations: Violation[] = [];
  let total = 0;
  const warnings: string[] = [];
  let warningsTotal = 0;
  const maxWarnings = opts.maxWarnings ?? 1000;
  const warn = (m: string): void => {
    warningsTotal++;
    if (warnings.length < maxWarnings) warnings.push(m);
  };
  const add = (v: Violation): void => {
    total++;
    if (violations.length < cap) violations.push(v);
  };

  const issuerHex = new Set(trust.issuers.map(hex));
  for (const k of trust.ledgerKeys) {
    if (issuerHex.has(hex(k))) throw new RangeError("a key cannot be both a certificate issuer and the ledger key: they are separate trust inputs");
  }
  const issuerById = new Map(trust.issuers.map((k) => [hex(keyIdOf(k)), k]));
  const ledgerById = new Map(trust.ledgerKeys.map((k) => [hex(keyIdOf(k)), k]));
  const issuerResolver = (id: Uint8Array) => issuerById.get(hex(id));
  const ledgerResolver = (id: Uint8Array) => ledgerById.get(hex(id));

  let phase: "start" | "certs" | "checkpoints" | "entries" = "start";
  let tenant: string | undefined;
  let exportedAtMs: number | undefined;
  const certs = new Map<string, CertState>();
  const certBytes = new Map<string, string>();

  // checkpoints
  let nextN = 1;
  let prevCheckpointHash: Uint8Array = ZERO_HASH;
  let lastCheckpointAt = -1;
  let lastCheckpointAtMs: number | undefined;
  let checkpointCount = 0;
  const exportedCheckpoints = new Map<number, Uint8Array>();
  /** doc -> (seq -> head hash and checkpoint time) attested by some checkpoint, still waiting to meet its entry. */
  const attested = new Map<string, Map<number, { hash: Uint8Array; createdAtMs: number }>>();
  const maxAttested = new Map<string, number>();

  // entries
  const docs = new Map<string, DocState>();
  let currentDoc: string | undefined;
  /** The gateway refuses a (key, session) whose client sequence does not increase; so does the verifier. */
  const sessions = new Map<string, number>();
  const finished = new Set<string>();
  let entries = 0;
  let erased = 0;

  for await (const raw of records) {
    const parsed = parseRecord(raw);
    if (!parsed.ok) {
      add({ code: "export_malformed", message: parsed.reason });
      continue;
    }
    const rec = parsed.record;

    if (rec.t === "meta") {
      if (phase !== "start") {
        add({ code: "export_order", message: "meta record must come first and only once" });
        continue;
      }
      phase = "certs";
      tenant = rec.tenant;
      exportedAtMs = rec.exportedAtMs;
      if (trust.tenant !== undefined && rec.tenant !== trust.tenant) {
        add({ code: "tenant_mismatch", message: `the export is for tenant ${JSON.stringify(rec.tenant)}, expected ${JSON.stringify(trust.tenant)}` });
      }
      if (rec.version !== EXPORT_VERSION) add({ code: "export_version", message: `unsupported export version ${rec.version}` });
      continue;
    }
    if (phase === "start") {
      add({ code: "export_order", message: "export must begin with a meta record" });
      phase = "certs";
    }

    if (rec.t === "cert") {
      if (phase !== "certs") {
        add({ code: "export_order", message: "certificate record after checkpoints or entries" });
        continue;
      }
      const key = hex(rec.serial);
      const sig = Buffer.from(rec.certificate).toString("base64");
      if (certBytes.has(key)) {
        if (certBytes.get(key) !== sig) add({ code: "cert_malformed", message: `two different certificates share serial ${key}` });
        continue;
      }
      certBytes.set(key, sig);
      const v = verifyCertificate(rec.certificate, issuerResolver);
      if (!v.ok) {
        const code: ViolationCode = v.reason === "untrusted_issuer" ? "cert_untrusted" : v.reason === "bad_signature" ? "cert_untrusted" : "cert_malformed";
        certs.set(key, { ok: false, code, message: `certificate ${key}: ${v.reason}` });
      } else if (!eq(v.certificate.serial, rec.serial)) {
        certs.set(key, { ok: false, code: "cert_malformed", message: `certificate ${key} carries a different serial` });
      } else {
        certs.set(key, { ok: true, cert: v.certificate });
      }
      continue;
    }

    if (rec.t === "checkpoint") {
      if (phase === "entries") {
        add({ code: "export_order", message: "checkpoint record after entries" });
        continue;
      }
      phase = "checkpoints";
      const v = verifyCheckpoint(rec.bytes, ledgerResolver);
      if (!v.ok) {
        add({ code: "checkpoint_signature", message: `checkpoint #${checkpointCount + 1}: ${v.reason}` });
        nextN++;
        continue;
      }
      const cp = v.checkpoint;
      checkpointCount++;
      exportedCheckpoints.set(cp.n, rec.bytes);
      if ((trust.tenant ?? tenant) !== undefined && cp.tenant !== (trust.tenant ?? tenant)) add({ code: "checkpoint_tenant", message: `checkpoint ${cp.n} is for tenant ${cp.tenant}`, n: cp.n });
      if (cp.n !== nextN) {
        add({ code: "checkpoint_gap", message: `expected checkpoint ${nextN}, found ${cp.n}`, n: cp.n });
      }
      if (!eq(cp.prevCheckpointHash, prevCheckpointHash)) {
        add({ code: "checkpoint_chain", message: `checkpoint ${cp.n} does not link to checkpoint ${cp.n - 1}`, n: cp.n });
      }
      if (cp.createdAtMs < lastCheckpointAt) add({ code: "checkpoint_time", message: `checkpoint ${cp.n} is older than its predecessor`, n: cp.n });
      lastCheckpointAt = cp.createdAtMs;
      lastCheckpointAtMs = cp.createdAtMs;
      prevCheckpointHash = checkpointHash(rec.bytes);
      nextN = cp.n + 1;
      for (const h of cp.heads) {
        const prevMax = maxAttested.get(h.documentId) ?? 0;
        if (h.seq <= prevMax) add({ code: "checkpoint_regress", message: `checkpoint ${cp.n} attests ${h.documentId} at ${h.seq}, not past ${prevMax}`, documentId: h.documentId, seq: h.seq, n: cp.n });
        maxAttested.set(h.documentId, Math.max(prevMax, h.seq));
        let m = attested.get(h.documentId);
        if (!m) attested.set(h.documentId, (m = new Map()));
        m.set(h.seq, { hash: h.headHash, createdAtMs: cp.createdAtMs });
      }
      continue;
    }

    // ----- entries -----------------------------------------------------------
    phase = "entries";
    entries++;
    checkEntry(rec);
  }
  if (phase === "start") add({ code: "export_order", message: "export is empty" });
  if (trust.tenant === undefined) warn("the tenant was not pinned: this export was only checked against its own tenant field");

  // ----- after the stream: checkpoints against what the export holds ------------
  let afterLast = 0;
  const docIds = new Set<string>([...docs.keys(), ...attested.keys()]);
  for (const id of docIds) {
    const d = docs.get(id);
    const lastSeq = d?.lastSeq ?? 0;
    const maxA = maxAttested.get(id) ?? 0;
    if (maxA > lastSeq) {
      add({ code: "truncated", message: `a checkpoint attests ${id} up to entry ${maxA}, but the export ends at ${lastSeq}`, documentId: id, seq: lastSeq });
    }
    afterLast += Math.max(0, lastSeq - maxA);
    for (const [seq] of attested.get(id) ?? []) {
      if (seq <= lastSeq) {
        add({ code: "checkpoint_head_mismatch", message: `attested entry ${seq} of ${id} was never matched`, documentId: id, seq });
      }
    }
  }

  let lockedProblems = 0;
  const lockedAdd = (v: Violation): void => {
    lockedProblems++;
    add(v);
  };
  if (opts.locked) {
    let lockedMax = 0;
    for (const n of opts.locked.keys()) if (n > lockedMax) lockedMax = n;
    for (const [n, bytes] of opts.locked) {
      const mine = exportedCheckpoints.get(n);
      if (mine === undefined) lockedAdd({ code: "locked_missing", message: `locked checkpoint ${n} is not in the export`, n });
      else if (!eq(mine, bytes)) lockedAdd({ code: "locked_mismatch", message: `checkpoint ${n} differs from the locked copy`, n });
    }
    for (const n of exportedCheckpoints.keys()) {
      if (!opts.locked.has(n) && n <= lockedMax) lockedAdd({ code: "locked_extra", message: `checkpoint ${n} is not in the locked store`, n });
      else if (!opts.locked.has(n)) warn(`checkpoint ${n} is newer than the newest locked copy`);
    }
  }
  if (checkpointCount === 0) warn("the export has no checkpoints: nothing in it is attested");
  else if (!opts.locked) warn("no locked checkpoint copies were supplied: the checkpoints were checked against the ledger key only");
  const anchored = opts.locked !== undefined && opts.locked.size > 0 && checkpointCount > 0 && lockedProblems === 0;

  return {
    ok: total === 0,
    anchored,
    lockedChecked: opts.locked?.size ?? 0,
    ...(tenant !== undefined ? { tenant } : {}),
    ...(exportedAtMs !== undefined ? { exportedAtMs } : {}),
    counts: { documents: docs.size, entries, certificates: certs.size, checkpoints: checkpointCount, erased, entriesAfterLastCheckpoint: afterLast },
    ...(lastCheckpointAtMs !== undefined ? { lastCheckpointAtMs } : {}),
    violations,
    violationsTotal: total,
    warnings,
    warningsTotal,
  };

  // ----- one entry ----------------------------------------------------------------
  function checkEntry(e: EntryRecord): void {
    const at = { documentId: e.doc, seq: e.seq };
    // Documents must be contiguous so the verifier can stay streaming.
    if (currentDoc !== e.doc) {
      if (currentDoc !== undefined) finished.add(currentDoc);
      if (finished.has(e.doc)) add({ code: "export_order", message: `entries of ${e.doc} are not contiguous`, ...at });
      currentDoc = e.doc;
      sessions.clear();
    }
    let d = docs.get(e.doc);
    if (!d) docs.set(e.doc, (d = { lastSeq: 0, lastHash: ZERO_HASH, lastReceivedAtMs: 0 }));

    if (e.seq !== d.lastSeq + 1) add({ code: "chain_gap", message: `${e.doc}: expected entry ${d.lastSeq + 1}, found ${e.seq}`, ...at });
    if (!eq(e.prevHash, d.lastHash)) add({ code: "chain_break", message: `${e.doc} entry ${e.seq} does not link to its predecessor`, ...at });

    // Never trust a field that can be recomputed: the hash below is the one the chain and checkpoints rely on.
    let computed: Uint8Array;
    try {
      computed = entryHash({
        documentId: e.doc,
        seq: e.seq,
        prevHash: e.prevHash,
        receivedAtMs: e.receivedAtMs,
        keyEpoch: e.keyEpoch,
        certSerial: e.certSerial,
        frameHash: e.frameHash,
        payloadHash: e.payloadHash,
      });
    } catch (err) {
      add({ code: "export_malformed", message: `${e.doc} entry ${e.seq}: ${(err as Error).message}`, ...at });
      computed = e.entryHash;
    }
    if (!eq(computed, e.entryHash)) add({ code: "entry_hash_mismatch", message: `${e.doc} entry ${e.seq}: stored hash is not the hash of its fields`, ...at });

    if (e.receivedAtMs < d.lastReceivedAtMs) warn(`${e.doc} entry ${e.seq}: receive time went backwards`);
    d.lastSeq = e.seq;
    d.lastHash = computed;
    d.lastReceivedAtMs = e.receivedAtMs;

    // Checkpoint heads are compared against the recomputed hash.
    const heads = attested.get(e.doc);
    const want = heads?.get(e.seq);
    if (want !== undefined) {
      if (!eq(want.hash, computed)) add({ code: "checkpoint_head_mismatch", message: `${e.doc} entry ${e.seq} differs from what a checkpoint signed`, ...at });
      // A checkpoint cannot attest an entry that, by the gateway's own clock, had not arrived yet.
      if (e.receivedAtMs > want.createdAtMs + skewMs) {
        add({ code: "received_after_checkpoint", message: `${e.doc} entry ${e.seq} was received after the checkpoint that attests it was made`, ...at });
      }
      heads?.delete(e.seq);
    }

    checkFrame(e, at);
  }

  function checkFrame(e: EntryRecord, at: { documentId: string; seq: number }): void {
    const state = e.certSerial === undefined ? undefined : certs.get(hex(e.certSerial));
    if (e.certSerial === undefined) add({ code: "cert_missing", message: `${e.doc} entry ${e.seq} has no certificate`, ...at });
    else if (state === undefined) add({ code: "cert_missing", message: `${e.doc} entry ${e.seq}: certificate ${hex(e.certSerial)} is not in the export`, ...at });
    else if (!state.ok) add({ code: state.code, message: `${e.doc} entry ${e.seq}: ${state.message}`, ...at });

    if (e.frame === undefined) {
      erased++;
      if (!opts.allowErased) add({ code: "frame_erased", message: `${e.doc} entry ${e.seq}: the frame is missing, so its signature cannot be checked`, ...at });
      if (state?.ok) checkWindow(e, state.cert, undefined, at);
      return;
    }
    if (!eq(hashBytes(e.frame), e.frameHash)) add({ code: "frame_hash_mismatch", message: `${e.doc} entry ${e.seq}: frame does not match its hash`, ...at });

    let frame: Frame;
    try {
      frame = decodeFrame(e.frame, { maxPayloadBytes: MAX_STORED_PAYLOAD });
    } catch {
      add({ code: "frame_malformed", message: `${e.doc} entry ${e.seq}: frame does not decode`, ...at });
      return;
    }
    if (!eq(hashBytes(frame.payload), e.payloadHash)) add({ code: "payload_hash_mismatch", message: `${e.doc} entry ${e.seq}: payload does not match its hash`, ...at });
    if (!state?.ok) return;

    const cert = state.cert;
    const v = verifyUpdate(e.frame, e.doc, (kid) => (frame.keyId !== undefined && eq(kid, keyIdOf(cert.publicKey)) ? cert.publicKey : undefined), {
      maxPayloadBytes: MAX_STORED_PAYLOAD,
    });
    if (!v.ok) {
      if (v.reason === "unknown_key") add({ code: "cert_key_mismatch", message: `${e.doc} entry ${e.seq}: the signing key is not the certificate's key`, ...at });
      else if (v.reason === "bad_signature") add({ code: "bad_signature", message: `${e.doc} entry ${e.seq}: signature does not verify for this document`, ...at });
      else add({ code: "frame_malformed", message: `${e.doc} entry ${e.seq}: not a signed UPDATE`, ...at });
    }
    const sk = `${hex(frame.keyId as Uint8Array)}:${frame.sessionId}`;
    const lastClientSeq = sessions.get(sk);
    if (lastClientSeq !== undefined && frame.seq <= lastClientSeq) {
      add({ code: "replay", message: `${e.doc} entry ${e.seq}: session ${frame.sessionId} repeated or went back to client sequence ${frame.seq} (after ${lastClientSeq})`, ...at });
    }
    sessions.set(sk, Math.max(lastClientSeq ?? 0, frame.seq));
    checkWindow(e, cert, frame, at);
  }

  function checkWindow(e: EntryRecord, cert: Certificate, frame: Frame | undefined, at: { documentId: string; seq: number }): void {
    if (e.receivedAtMs < cert.notBeforeMs - skewMs || e.receivedAtMs > cert.notAfterMs + graceMs) {
      add({ code: "cert_window", message: `${e.doc} entry ${e.seq}: received outside the certificate's validity plus grace`, ...at });
    }
    if (frame === undefined) return;
    if (frame.claimedAtMs < cert.notBeforeMs || frame.claimedAtMs > cert.notAfterMs) {
      add({ code: "claimed_window", message: `${e.doc} entry ${e.seq}: claimed time is outside the certificate's validity`, ...at });
    }
    if (frame.claimedAtMs > e.receivedAtMs + skewMs) {
      add({ code: "claimed_in_future", message: `${e.doc} entry ${e.seq}: claimed time is after it was received`, ...at });
    }
  }
}

