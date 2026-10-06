import type { Report } from "./verify.js";

/** Human-readable report an auditor can keep. */
export function formatReport(r: Report): string {
  const c = r.counts;
  const out: string[] = [];
  out.push(r.ok ? (r.anchored ? `RESULT: VERIFIED and anchored to ${r.lockedChecked} locked checkpoint${r.lockedChecked === 1 ? "" : "s"}` : "RESULT: CONSISTENT, NOT ANCHORED (not compared with locked checkpoints; do not rely on it against someone who controls the database)") : `RESULT: FAILED (${r.violationsTotal} violation${r.violationsTotal === 1 ? "" : "s"})`);
  if (r.tenant !== undefined) out.push(`tenant:        ${r.tenant}`);
  if (r.exportedAtMs !== undefined) out.push(`exported at:   ${new Date(r.exportedAtMs).toISOString()}`);
  out.push(`documents:     ${c.documents}`);
  out.push(`entries:       ${c.entries}${c.erased > 0 ? ` (${c.erased} with payload erased, hashes verified)` : ""}`);
  out.push(`certificates:  ${c.certificates}`);
  out.push(`checkpoints:   ${c.checkpoints}${r.lastCheckpointAtMs !== undefined ? ` (latest ${new Date(r.lastCheckpointAtMs).toISOString()})` : ""}`);
  out.push(`unattested:    ${c.entriesAfterLastCheckpoint} entr${c.entriesAfterLastCheckpoint === 1 ? "y" : "ies"} newer than the last checkpoint of their document`);
  for (const v of r.violations) out.push(`  VIOLATION ${v.code}: ${v.message}`);
  if (r.violationsTotal > r.violations.length) out.push(`  ... and ${r.violationsTotal - r.violations.length} more`);
  for (const w of r.warnings.slice(0, 50)) out.push(`  warning: ${w}`);
  if (r.warningsTotal > Math.min(50, r.warnings.length)) out.push(`  ... and ${r.warningsTotal - Math.min(50, r.warnings.length)} more warnings`);
  return out.join("\n") + "\n";
}
