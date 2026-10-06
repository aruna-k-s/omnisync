#!/usr/bin/env node
import { createReadStream, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { hexToBytes } from "@omnisync/protocol";
import { formatReport } from "./format.js";
import { verifyLedger, type TrustInputs } from "./verify.js";

const USAGE = `usage: omnisync verify <export.ndjson> --issuer <hex|@file>... --ledger-key <hex|@file>... [--tenant <name>] [--locked <dir>] [--allow-unanchored] [--allow-erased] [--grace-ms <n>] [--json]

  --issuer            public key of a trusted certificate issuer (64 hex chars, or @path to a file holding it). Repeatable.
  --ledger-key        public key of the ledger signing key. Repeatable. Must differ from every issuer key.
  --tenant            the tenant you expect. Without it the export's own tenant field is trusted, and you are warned.
  --locked            directory (searched recursively) with checkpoint objects fetched from the locked bucket: files named <12 digits>.ckpt
  --allow-unanchored  accept an export that was not compared with locked checkpoints (exit 0 instead of 3)
  --allow-erased      accept entries whose frames were erased (their signatures cannot be checked)
  --json              print the report as JSON
exit status: 0 verified and anchored, 1 violations found, 2 unusable input, 3 consistent but NOT anchored to locked checkpoints`;

class UsageError extends Error {}

async function key(v: string): Promise<Uint8Array> {
  const text = v.startsWith("@") ? (await readFile(v.slice(1), "utf8")).trim() : v;
  if (!/^[0-9a-f]{64}$/.test(text)) throw new UsageError("a public key is 64 lowercase hex characters");
  return hexToBytes(text);
}

const CHECKPOINT_FILE = /^(\d{12})\.ckpt$/;

/** Every checkpoint file under `dir`, any depth, symbolic links ignored. Two files for one number, or none at all, is an error. */
async function lockedDir(dir: string): Promise<Map<number, Uint8Array>> {
  const out = new Map<number, Uint8Array>();
  const where = new Map<number, string>();
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      throw new UsageError(`--locked: cannot read directory ${d}`);
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const path = join(d, e.name);
      if (e.isDirectory()) await walk(path);
      else if (e.isFile()) {
        const m = CHECKPOINT_FILE.exec(e.name);
        if (!m) continue;
        const n = Number(m[1]);
        const seen = where.get(n);
        if (seen !== undefined) throw new UsageError(`--locked: checkpoint ${n} appears twice (${seen} and ${path}); point --locked at one tenant's directory`);
        where.set(n, path);
        out.set(n, new Uint8Array(await readFile(path)));
      }
    }
  };
  await walk(dir);
  if (out.size === 0) throw new UsageError(`--locked: no <12 digits>.ckpt files under ${dir}`);
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
    let tenant: string | undefined;
    let allowUnanchored = false;
    let allowErased = false;
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
      } else if (flag === "--tenant") tenant = val();
      else if (flag === "--allow-unanchored") allowUnanchored = true;
      else if (flag === "--allow-erased") allowErased = true;
      else if (flag === "--json") json = true;
      else throw new UsageError(`unknown option ${flag}`);
    }
    if (issuers.length === 0 || ledgerKeys.length === 0) throw new UsageError("give at least one --issuer and one --ledger-key");
    const trust: TrustInputs = { issuers, ledgerKeys, ...(graceMs !== undefined ? { graceMs } : {}), ...(tenant !== undefined ? { tenant } : {}) };
    let report;
    try {
      report = await verifyLedger(lines(file), trust, { ...(locked ? { locked } : {}), allowErased });
    } catch (e) {
      if (e instanceof RangeError) throw new UsageError(e.message);
      throw e;
    }
    out(json ? JSON.stringify(report, null, 2) + "\n" : formatReport(report));
    if (!report.ok) return 1;
    return report.anchored || allowUnanchored ? 0 : 3;
  } catch (e) {
    const m = (e as Error).message;
    process.stderr.write(`${m ? m + "\n" : ""}${USAGE}\n`);
    return 2;
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
