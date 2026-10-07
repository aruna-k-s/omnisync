/**
 * Where the command line keeps its device key and profile (spec: docs/specs/device-login.md, "Command line").
 *
 * The key is a file, the one place this codebase writes a device secret to disk: a Node process has no
 * non-extractable key store. So the file is created private (0600 in a 0700 directory), written atomically, never
 * overwritten, never logged, and refused on load if anyone else could read it.
 */
import { randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { generateKeyPair, hexToBytes, type KeyPair } from "@omnisync/protocol";

export class ProfileError extends Error {
  override readonly name = "ProfileError";
}

/** What `login` learned, kept so `whoami` and later commands need no network. No secret in here. */
export interface Profile {
  server: string;
  gateway?: string;
  principalId: string;
  email: string;
  keyId: string;
  serial: string;
  notAfterMs: number;
  /** The signed certificate, base64url. Useless without the key. */
  certificate: string;
}

const KEY_FILE = "key.json";
const PROFILE_FILE = "profile.json";
const windows = process.platform === "win32";

export function homeDir(env: Record<string, string | undefined>): string {
  const explicit = env["OMNISYNC_HOME"];
  if (explicit) {
    if (!isAbsolute(explicit)) throw new ProfileError("OMNISYNC_HOME must be an absolute path");
    return explicit;
  }
  const home = env["HOME"] || env["USERPROFILE"];
  if (!home) throw new ProfileError("cannot find a home directory: set OMNISYNC_HOME");
  return join(home, ".omnisync");
}

async function privateDir(dir: string, create: boolean): Promise<boolean> {
  if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
  let s;
  try {
    s = await lstat(dir);
  } catch {
    return false;
  }
  if (!s.isDirectory()) throw new ProfileError(`${dir} is not a directory`);
  if (!windows && (s.mode & 0o077) !== 0) throw new ProfileError(`${dir} is accessible to other users: run chmod 700 ${dir}`);
  return true;
}

/** Writes a new file nobody else can see, in one step: a temporary file in the same directory, then a link or rename. */
async function writePrivate(dir: string, name: string, text: string, mode: "create" | "replace"): Promise<void> {
  await privateDir(dir, true);
  const target = join(dir, name);
  const tmp = join(dir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, text, { flag: "wx", mode: 0o600 });
    if (!windows) await chmod(tmp, 0o600);
    if (mode === "replace") {
      await rename(tmp, target);
    } else {
      try {
        await link(tmp, target); // fails if the target exists: a key is never replaced
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new ProfileError(`${target} already exists; remove it with "logout" first`);
        throw e;
      }
    }
  } finally {
    await rm(tmp, { force: true });
  }
}

async function readPrivate(dir: string, name: string): Promise<string | undefined> {
  if (!(await privateDir(dir, false))) return undefined;
  const file = join(dir, name);
  let s;
  try {
    s = await lstat(file);
  } catch {
    return undefined;
  }
  if (!s.isFile()) throw new ProfileError(`${file} is not a regular file`);
  if (!windows && (s.mode & 0o077) !== 0) throw new ProfileError(`${file} is readable by other users: run chmod 600 ${file}`);
  return readFile(file, "utf8");
}

const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`);

export async function saveKey(dir: string, pair: KeyPair): Promise<void> {
  const body = { v: 1, secretKey: Buffer.from(pair.secretKey).toString("hex"), publicKey: Buffer.from(pair.publicKey).toString("hex") };
  await writePrivate(dir, KEY_FILE, JSON.stringify(body) + "\n", "create");
}

/** The stored key, or undefined if there is none. Throws `ProfileError` for a key that is damaged, inconsistent or readable by others. */
export async function loadKey(dir: string): Promise<KeyPair | undefined> {
  const text = await readPrivate(dir, KEY_FILE);
  if (text === undefined) return undefined;
  const bad = (why: string): ProfileError => new ProfileError(`${join(dir, KEY_FILE)} is ${why}`);
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw bad("not valid JSON");
  }
  const o = j as { v?: unknown; secretKey?: unknown; publicKey?: unknown } | null;
  if (typeof o !== "object" || o === null || o.v !== 1 || typeof o.secretKey !== "string" || typeof o.publicKey !== "string" || !HEX(64).test(o.secretKey) || !HEX(64).test(o.publicKey)) {
    throw bad("not a key file this version understands");
  }
  const pair = generateKeyPair(hexToBytes(o.secretKey));
  if (Buffer.from(pair.publicKey).toString("hex") !== o.publicKey) throw bad("inconsistent: its public key does not match its secret");
  return pair;
}

export async function saveProfile(dir: string, p: Profile): Promise<void> {
  await writePrivate(dir, PROFILE_FILE, JSON.stringify(p, null, 2) + "\n", "replace");
}

const str = (v: unknown): v is string => typeof v === "string" && v !== "";

export async function loadProfile(dir: string): Promise<Profile | undefined> {
  const text = await readPrivate(dir, PROFILE_FILE);
  if (text === undefined) return undefined;
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new ProfileError(`${join(dir, PROFILE_FILE)} is not valid JSON`);
  }
  const o = j as Record<string, unknown> | null;
  if (
    typeof o !== "object" || o === null ||
    !str(o["server"]) || !str(o["principalId"]) || typeof o["email"] !== "string" || !str(o["certificate"]) ||
    !str(o["keyId"]) || !HEX(16).test(o["keyId"]) || !str(o["serial"]) || !HEX(32).test(o["serial"]) ||
    typeof o["notAfterMs"] !== "number" || !Number.isFinite(o["notAfterMs"]) ||
    (o["gateway"] !== undefined && !str(o["gateway"]))
  ) {
    throw new ProfileError(`${join(dir, PROFILE_FILE)} is not a profile this version understands`);
  }
  return {
    server: o["server"], principalId: o["principalId"], email: o["email"], keyId: o["keyId"], serial: o["serial"],
    notAfterMs: o["notAfterMs"], certificate: o["certificate"],
    ...(o["gateway"] !== undefined ? { gateway: o["gateway"] } : {}),
  };
}

/** Deletes the key and the profile, nothing else in the directory. Missing files are fine. */
export async function removeAll(dir: string): Promise<void> {
  await rm(join(dir, KEY_FILE), { force: true });
  await rm(join(dir, PROFILE_FILE), { force: true });
}

