#!/usr/bin/env node
import { createReadStream, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readFile, readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { hexToBytes } from "@omnisync/protocol";
import { formatReport } from "./format.js";
import { verifyLedger, type TrustInputs } from "./verify.js";

const USAGE = `usage: omnisync verify <export.ndjson> --issuer <hex|@file>... --ledger-key <hex|@file>... [--locked <dir>] [--grace-ms <n>] [--json]

  --issuer      public key of a trusted certificate issuer (64 hex chars, or @path to a file holding it). Repeatable.
  --ledger-key  public key of the ledger signing key. Repeatable.
  --locked      directory with the checkpoint objects fetched from the locked bucket (*.ckpt, names end in the number)
  --json        print the report as JSON
exit status: 0 verified, 1 violations found, 2 unusable input`;

class UsageError extends Error {}

async function key(v: string): Promise<Uint8Array> {
  const text = v.startsWith("@") ? (await readFile(v.slice(1), "utf8")).trim() : v;
  if (!/^[0-9a-f]{64}$/.test(text)) throw new UsageError("a public key is 64 lowercase hex characters");
  return hexToBytes(text);
}

async function lockedDir(dir: string): Promise<Map<number, Uint8Array>> {
  const out = new Map<number, Uint8Array>();
  for (const f of await readdir(dir)) {
    const m = /(\d+)\.ckpt$/.exec(f);
    if (m) out.set(Number(m[1]), new Uint8Array(await readFile(`${dir}/${f}`)));
  }
  return out;
}

async function* lines(path: string): AsyncGenerator<unknown> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const l of rl) {
    if (l.trim() === "") continue;
    try {
      yield JSON.parse(l) as unknown;
    } catch {
      yield null; // reported as export_malformed
    }
  }
}

export async function main(argv: readonly string[], out: (s: string) => void = (s) => process.stdout.write(s)): Promise<number> {
  try {
    const [cmd, file, ...rest] = argv;
    if (cmd !== "verify" || file === undefined || file.startsWith("--")) throw new UsageError("");
    const issuers: Uint8Array[] = [];
    const ledgerKeys: Uint8Array[] = [];
    let locked: Map<number, Uint8Array> | undefined;
    let graceMs: number | undefined;
    let json = false;
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      const val = (): string => {
        const v = rest[++i];
        if (v === undefined) throw new UsageError(`${flag} needs a value`);
        return v;
      };
      if (flag === "--issuer") issuers.push(await key(val()));
      else if (flag === "--ledger-key") ledgerKeys.push(await key(val()));
      else if (flag === "--locked") locked = await lockedDir(val());
      else if (flag === "--grace-ms") {
        graceMs = Number(val());
        if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw new UsageError("--grace-ms must be a non-negative integer");
      } else if (flag === "--json") json = true;
      else throw new UsageError(`unknown option ${flag}`);
    }
    if (issuers.length === 0 || ledgerKeys.length === 0) throw new UsageError("give at least one --issuer and one --ledger-key");
    const trust: TrustInputs = { issuers, ledgerKeys, ...(graceMs !== undefined ? { graceMs } : {}) };
    const report = await verifyLedger(lines(file), trust, locked ? { locked } : {});
    out(json ? JSON.stringify(report, null, 2) + "\n" : formatReport(report));
    return report.ok ? 0 : 1;
  } catch (e) {
    const m = (e as Error).message;
    process.stderr.write(`${m ? m + "\n" : ""}${USAGE}\n`);
    return 2;
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
