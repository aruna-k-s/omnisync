import { hostname, userInfo } from "node:os";
import { DeviceLoginError } from "@omnisync/sdk";
import { USAGE, UsageError, parseArgs } from "./args.js";
import { ProfileError, homeDir, loadProfile, removeAll } from "./files.js";
import { login, whoami } from "./login.js";

export interface Io {
  out(line: string): void;
  err(line: string): void;
}
export interface Deps {
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
  /** `user@host`, for the default label. */
  who?: () => string;
}

const defaultWho = (): string => {
  try {
    return `${userInfo().username}@${hostname()}`;
  } catch {
    return hostname();
  }
};
/** Letters, digits and a few separators: the label is shown to the approver and kept in the audit trail. */
const printable = (s: string): string => s.replace(/[^A-Za-z0-9@._ -]/g, "").slice(0, 64);

/** Runs one command and returns its exit status: 0 success, 1 failed or not signed in, 2 bad usage. */
export async function run(argv: readonly string[], env: Record<string, string | undefined>, io: Io, deps: Deps = {}): Promise<number> {
  try {
    const cmd = parseArgs(argv, env);
    if (cmd.command === "help") {
      io.out(USAGE);
      return 0;
    }
    const dir = homeDir(env);
    const now = deps.now ?? Date.now;

    if (cmd.command === "whoami") {
      const w = whoami(await loadProfile(dir), now());
      for (const l of w.lines) (w.ok ? io.out : io.err)(l);
      return w.ok ? 0 : 1;
    }

    if (cmd.command === "logout") {
      const p = await loadProfile(dir).catch(() => undefined);
      await removeAll(dir);
      io.out("Signed out: the key and certificate on this machine are deleted.");
      if (p && p.notAfterMs > now()) io.out(`The certificate stays valid until ${new Date(p.notAfterMs).toISOString()} unless an admin revokes it in the console.`);
      return 0;
    }

    const label = cmd.label !== undefined ? printable(cmd.label) : printable((deps.who ?? defaultWho)());
    const profile = await login(
      { server: cmd.server, ...(cmd.gateway ? { gateway: cmd.gateway } : {}), label, dir },
      {
        out: io.out,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
      },
    );
    io.out(`Signed in as ${profile.email || profile.principalId}. The certificate expires ${new Date(profile.notAfterMs).toISOString()}.`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`error: ${e.message}`);
      io.err(USAGE);
      return 2;
    }
    if (e instanceof DeviceLoginError) {
      io.err(e.code === "aborted" ? "cancelled" : `login failed: ${e.message}`);
      return 1;
    }
    if (e instanceof ProfileError) {
      io.err(`error: ${e.message}`);
      return 1;
    }
    io.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
