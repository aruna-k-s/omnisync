import { bytesToHex, hexToBytes } from "@omnisync/protocol";

/**
 * Export format (spec: docs/specs/ledger.md): newline-delimited JSON, in the order
 * meta, cert*, checkpoint*, entry*. Hashes are hex; frames, certificates and
 * checkpoints are base64. Anything that does not parse is a violation, never a crash.
 */

export const EXPORT_VERSION = 1;

export interface MetaRecord {
  readonly t: "meta";
  readonly version: number;
  readonly tenant: string;
  readonly exportedAtMs: number;
}
export interface CertRecordOut {
  readonly t: "cert";
  readonly serial: Uint8Array;
  readonly certificate: Uint8Array;
}
export interface CheckpointRecordOut {
  readonly t: "checkpoint";
  readonly bytes: Uint8Array;
}
export interface EntryRecord {
  readonly t: "entry";
  readonly doc: string;
  readonly seq: number;
  readonly receivedAtMs: number;
  readonly certSerial?: Uint8Array;
  readonly keyEpoch: number;
  readonly prevHash: Uint8Array;
  readonly entryHash: Uint8Array;
  readonly frameHash: Uint8Array;
  readonly payloadHash: Uint8Array;
  /** Absent after erasure; every hash stays. */
  readonly frame?: Uint8Array;
}
export type ExportRecord = MetaRecord | CertRecordOut | CheckpointRecordOut | EntryRecord;

export type ParseResult = { readonly ok: true; readonly record: ExportRecord } | { readonly ok: false; readonly reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNat = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function hex(v: unknown, bytes: number, name: string): Uint8Array {
  if (typeof v !== "string" || v.length !== bytes * 2 || !/^[0-9a-f]+$/.test(v)) throw new Error(`${name} must be ${bytes} bytes of lowercase hex`);
  return hexToBytes(v);
}

function b64(v: unknown, name: string): Uint8Array {
  if (typeof v !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(v) || v.length % 4 !== 0) throw new Error(`${name} must be base64`);
  return new Uint8Array(Buffer.from(v, "base64"));
}

/** Never throws. */
export function parseRecord(v: unknown): ParseResult {
  try {
    if (!isObj(v)) return { ok: false, reason: "record is not an object" };
    switch (v.t) {
      case "meta":
        if (!isNat(v.version) || typeof v.tenant !== "string" || v.tenant === "" || !isNat(v.exportedAtMs)) return { ok: false, reason: "bad meta fields" };
        return { ok: true, record: { t: "meta", version: v.version, tenant: v.tenant, exportedAtMs: v.exportedAtMs } };
      case "cert":
        return { ok: true, record: { t: "cert", serial: hex(v.serial, 16, "serial"), certificate: b64(v.certificate, "certificate") } };
      case "checkpoint":
        return { ok: true, record: { t: "checkpoint", bytes: b64(v.bytes, "bytes") } };
      case "entry": {
        if (typeof v.doc !== "string" || v.doc === "") return { ok: false, reason: "bad doc" };
        if (!isNat(v.seq) || v.seq < 1 || !isNat(v.receivedAtMs) || !isNat(v.keyEpoch)) return { ok: false, reason: "bad numeric fields" };
        return {
          ok: true,
          record: {
            t: "entry",
            doc: v.doc,
            seq: v.seq,
            receivedAtMs: v.receivedAtMs,
            keyEpoch: v.keyEpoch,
            ...(v.certSerial === undefined ? {} : { certSerial: hex(v.certSerial, 16, "certSerial") }),
            prevHash: hex(v.prevHash, 32, "prevHash"),
            entryHash: hex(v.entryHash, 32, "entryHash"),
            frameHash: hex(v.frameHash, 32, "frameHash"),
            payloadHash: hex(v.payloadHash, 32, "payloadHash"),
            ...(v.frame === undefined ? {} : { frame: b64(v.frame, "frame") }),
          },
        };
      }
      default:
        return { ok: false, reason: "unknown record type" };
    }
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** One line of the export for `record`. */
export function encodeRecord(r: ExportRecord): string {
  switch (r.t) {
    case "meta":
      return JSON.stringify(r);
    case "cert":
      return JSON.stringify({ t: "cert", serial: bytesToHex(r.serial), certificate: Buffer.from(r.certificate).toString("base64") });
    case "checkpoint":
      return JSON.stringify({ t: "checkpoint", bytes: Buffer.from(r.bytes).toString("base64") });
    case "entry":
      return JSON.stringify({
        t: "entry",
        doc: r.doc,
        seq: r.seq,
        receivedAtMs: r.receivedAtMs,
        ...(r.certSerial ? { certSerial: bytesToHex(r.certSerial) } : {}),
        keyEpoch: r.keyEpoch,
        prevHash: bytesToHex(r.prevHash),
        entryHash: bytesToHex(r.entryHash),
        frameHash: bytesToHex(r.frameHash),
        payloadHash: bytesToHex(r.payloadHash),
        ...(r.frame ? { frame: Buffer.from(r.frame).toString("base64") } : {}),
      });
  }
}
