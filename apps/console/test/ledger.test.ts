import { describe, expect, it } from "vitest";
import { bytesToHex } from "@omnisync/protocol";
import { Fixture, issuer, ledger, stranger } from "../../../packages/verifier/test/fixture.js";
import { MAX_ENTRIES_SHOWN, verifyExport } from "../src/app/ledger.js";
import type { TrustInfo } from "../src/app/api.js";

const trust = (over: Partial<TrustInfo> = {}): TrustInfo => ({ tenant: "acme", issuers: [bytesToHex(issuer.publicKey)], ledgerKeys: [bytesToHex(ledger.publicKey)], anchored: false, ...over });
const DOC_A = "00000000-0000-4000-8000-00000000000a";

async function twoEntries(): Promise<Fixture> {
  const f = new Fixture();
  const u = f.addUser(1);
  f.append(DOC_A, u);
  f.append(DOC_A, u);
  await f.checkpoint();
  return f;
}
const text = (lines: string[]): string => lines.join("\n") + "\n";

describe("verifyExport", () => {
  it("ticks every entry of a consistent export, names the signer, and never says anchored", async () => {
    const f = await twoEntries();
    const v = await verifyExport(text(f.lines()), trust());
    expect(v.status).toBe("consistent");
    expect(v.headline).toContain("Not anchored");
    expect(v.report?.anchored).toBe(false);
    expect(v.total).toBe(2);
    expect(v.entries.map((e) => [e.doc, e.seq, e.verified, e.signer])).toEqual([
      [DOC_A, 1, true, "user:u1"],
      [DOC_A, 2, true, "user:u1"],
    ]);
    expect(v.entries[0]?.entryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(v.entries[0]?.hashShort).toBe(v.entries[0]?.entryHash.slice(0, 16));
    expect(v.entries[0]?.problem).toBeUndefined();
  });

  it("fails an export whose entry was rewritten, and marks the named entries, not the others", async () => {
    const f = await twoEntries();
    const lines = f.lines();
    const i = lines.findIndex((l) => l.startsWith('{"t":"entry"'));
    const rec = JSON.parse(lines[i] as string) as { payloadHash: string };
    rec.payloadHash = (rec.payloadHash.startsWith("00") ? "ff" : "00") + rec.payloadHash.slice(2);
    lines[i] = JSON.stringify(rec);
    const v = await verifyExport(text(lines), trust());
    expect(v.status).toBe("failed");
    expect(v.report?.violationsTotal).toBe(3);
    expect(v.headline).toMatch(/^3 violations found\./);
    expect(v.report?.violationsTotal).toBeGreaterThan(0);
    // No entry is ticked on a failed export; the ones a violation names say why.
    expect(v.entries.every((e) => !e.verified)).toBe(true);
    expect(v.entries.find((e) => e.seq === 1)?.problem).toBeTruthy();
  });

  it("fails when the trusted keys are not the ones that signed (a stranger's ledger key)", async () => {
    const f = await twoEntries();
    const v = await verifyExport(text(f.lines()), trust({ ledgerKeys: [bytesToHex(stranger.publicKey)] }));
    expect(v.status).toBe("failed");
  });

  it("pins the tenant to what the server says, not to what the export claims", async () => {
    const f = await twoEntries();
    const v = await verifyExport(text(f.lines()), trust({ tenant: "other" }));
    expect(v.status).toBe("failed");
    expect(v.report?.violations.map((x) => x.code)).toContain("tenant_mismatch");
  });

  it("reports an empty export and a keys-in-both-roles setup as unreadable, without throwing", async () => {
    expect((await verifyExport("", trust())).status).toBe("unreadable");
    expect((await verifyExport("\n\n  \n", trust())).status).toBe("unreadable");
    const f = await twoEntries();
    const same = await verifyExport(text(f.lines()), trust({ ledgerKeys: [bytesToHex(issuer.publicKey)] }));
    expect(same.status).toBe("unreadable");
    expect(same.headline).toContain("cannot be both");
  });

  it("treats a line that is not JSON as a violation, in place, and keeps going", async () => {
    const f = await twoEntries();
    const lines = f.lines();
    lines.splice(1, 0, "{not json");
    const v = await verifyExport(text(lines), trust());
    expect(v.status).toBe("failed");
    expect(v.report?.violations.map((x) => x.code)).toContain("export_malformed");
    expect(v.report?.violationsTotal).toBe(1);
    expect(v.headline).toMatch(/^1 violation found\./);
  });

  it("shows at most MAX_ENTRIES_SHOWN entries but counts and verifies all", async () => {
    const f = new Fixture();
    const u = f.addUser(1);
    for (let i = 0; i < MAX_ENTRIES_SHOWN + 25; i++) f.append(DOC_A, u);
    await f.checkpoint();
    const v = await verifyExport(text(f.lines()), trust());
    expect(v.status).toBe("consistent");
    expect(v.total).toBe(MAX_ENTRIES_SHOWN + 25);
    expect(v.entries).toHaveLength(MAX_ENTRIES_SHOWN);
    expect(v.report?.counts.entries).toBe(MAX_ENTRIES_SHOWN + 25);
  }, 60_000);

  it("leaves the signer blank for an entry whose certificate is not in the export", async () => {
    const f = await twoEntries();
    const lines = f.lines().filter((l) => !l.startsWith('{"t":"cert"'));
    const v = await verifyExport(text(lines), trust());
    expect(v.status).toBe("failed"); // an entry naming a certificate the export lacks is a violation
    expect(v.entries.every((e) => e.signer === undefined)).toBe(true);
  });
});
