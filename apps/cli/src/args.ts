export class UsageError extends Error {
  override readonly name = "UsageError";
}

export type Command =
  | { command: "help" }
  | { command: "whoami" }
  | { command: "logout" }
  | { command: "login"; server: string; gateway?: string; label?: string };

export const USAGE = `usage: omnisync-cli <command>

  login --server <url> [--gateway <ws-url>] [--label <text>]
        sign this machine in: shows a code to approve in your browser, then keeps a device key and certificate
  whoami    show who this machine is signed in as, and when the certificate expires
  logout    forget the key and certificate on this machine

environment: OMNISYNC_SERVER, OMNISYNC_GATEWAY (defaults for --server, --gateway), OMNISYNC_HOME (default ~/.omnisync)
exit status: 0 success, 1 failed or not signed in, 2 bad usage`;

const LOGIN_OPTIONS = new Set(["server", "gateway", "label"]);

export function parseArgs(argv: readonly string[], env: Record<string, string | undefined>): Command {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") return { command: "help" };
  if (cmd !== "login" && cmd !== "whoami" && cmd !== "logout") throw new UsageError(`unknown command "${cmd}"`);

  const opts = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (!a.startsWith("--")) throw new UsageError(`unexpected argument "${a}"`);
    const eq = a.indexOf("=");
    const name = a.slice(2, eq < 0 ? undefined : eq);
    if (cmd !== "login" || !LOGIN_OPTIONS.has(name)) throw new UsageError(`unknown option "--${name}"`);
    let value: string | undefined;
    if (eq >= 0) value = a.slice(eq + 1);
    else if (rest[i + 1] !== undefined && !(rest[i + 1] as string).startsWith("--")) value = rest[++i];
    if (value === undefined || value === "") throw new UsageError(`--${name} needs a value`);
    if (opts.has(name)) throw new UsageError(`--${name} given more than once`);
    opts.set(name, value);
  }

  if (cmd !== "login") return { command: cmd };
  const server = opts.get("server") ?? env["OMNISYNC_SERVER"];
  if (!server) throw new UsageError("login needs --server <url> (or OMNISYNC_SERVER)");
  const gateway = opts.get("gateway") ?? (env["OMNISYNC_GATEWAY"] || undefined);
  const label = opts.get("label");
  return { command: "login", server, ...(gateway ? { gateway } : {}), ...(label ? { label } : {}) };
}
