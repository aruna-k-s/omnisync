#!/usr/bin/env node
import { run } from "./cli.js";

// Ctrl-C stops a login that is waiting for approval; nothing has been written by then.
const ctl = new AbortController();
process.once("SIGINT", () => ctl.abort());
process.once("SIGTERM", () => ctl.abort());

const code = await run(
  process.argv.slice(2),
  process.env,
  { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) },
  { signal: ctl.signal },
);
process.exitCode = code;
