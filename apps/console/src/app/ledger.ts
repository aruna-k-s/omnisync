import { decodeCertificate } from "@omnisync/crypto";
import { hexToBytes } from "@omnisync/protocol";
import { parseRecord, verifyLedger, type Report } from "@omnisync/verifier";
import type { TrustInfo } from "./api.js";

/**
 * Runs the real verifier on an export, in the page. The keys come from the same server as the export, so the
 * strongest thing this can say is "consistent": it never says "anchored" (spec: admin-api.md, trust inputs).
 */

export interface EntryView {
  doc: string;
  seq: number;
  receivedAtMs: number;
  /** First 16 hex characters of the entry hash; the full hash is on hover. */
  hashShort: string;
  entryHash: string;
  /** Who signed it: the principal named by the certificate, when the export carries it. */
  signer?: string;
  verified: boolean;
  problem?: string;
}

export interface LedgerView {
  /** `consistent`: no violations. `failed`: at least one. `unreadable`: the export did not parse at all. */
  status: "consistent" | "failed" | "unreadable";
  headline: string;
  report?: Report;
  entries: EntryView[];
  /** Entries in the export; `entries` holds at most `MAX_ENTRIES_SHOWN`. */
  total: number;
}

export const MAX_ENTRIES_SHOWN = 500;

export async function verifyExport(text: string, trust: TrustInfo): Promise<LedgerView> {
  const raw: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      raw.push(JSON.parse(line));
    } catch {
      // The verifier reports a non-object as export_malformed, in order, with everything else.
      raw.push(null);
    }
  }
  if (raw.length === 0) return { status: "unreadable", headline: "The export is empty.", entries: [], total: 0 };

  let report: Report;
  try {
    report = await verifyLedger(raw, {
      issuers: trust.issuers.map(hexToBytes),
      ledgerKeys: trust.ledgerKeys.map(hexToBytes),
      tenant: trust.tenant,
    });
  } catch (e) {
    return { status: "unreadable", headline: `The verifier could not run: ${e instanceof Error ? e.message : String(e)}`, entries: [], total: 0 };
  }

  // Which entries a violation names. Violations without a position (a bad checkpoint, a tenant mismatch) make
  // the whole export unverified, so no entry gets a tick then.
  const bad = new Map<string, string>();
  for (const v of report.violations) if (v.documentId !== undefined && v.seq !== undefined) bad.set(`${v.documentId}:${v.seq}`, v.message);

  const subjects = new Map<string, string>();
  const entries: EntryView[] = [];
  let total = 0;
  for (const r of raw) {
    const p = parseRecord(r);
    if (!p.ok) continue;
    const rec = p.record;
    if (rec.t === "cert") {
      try {
        subjects.set(hex(rec.serial), decodeCertificate(rec.certificate).subject);
      } catch {
        // already a violation in the report
      }
    } else if (rec.t === "entry") {
      total++;
      if (entries.length >= MAX_ENTRIES_SHOWN) continue;
      const key = `${rec.doc}:${rec.seq}`;
      const problem = bad.get(key);
      const signer = rec.certSerial ? subjects.get(hex(rec.certSerial)) : undefined;
      const entryHash = hex(rec.entryHash);
      entries.push({
        doc: rec.doc,
        seq: rec.seq,
        receivedAtMs: rec.receivedAtMs,
        entryHash,
        hashShort: entryHash.slice(0, 16),
        ...(signer !== undefined ? { signer } : {}),
        verified: report.ok,
        ...(problem !== undefined ? { problem } : {}),
      });
    }
  }

  return report.ok
    ? {
        status: "consistent",
        headline: "Hash chains, signatures, certificates and checkpoints agree with each other and with the keys this server supplied. Not anchored: compare with the locked checkpoints (omnisync verify) before relying on it against someone who controls the database.",
        report,
        entries,
        total,
      }
    : {
        status: "failed",
        headline: `${report.violationsTotal} violation${report.violationsTotal === 1 ? "" : "s"} found. Do not rely on this export.`,
        report,
        entries,
        total,
      };
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
