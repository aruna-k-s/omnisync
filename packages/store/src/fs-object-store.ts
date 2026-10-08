import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { assertObjectKey } from "./object-key.js";
import type { ObjectStore } from "./types.js";

/** Development and single-host ObjectStore on a local directory. Production uses the S3 adapter (`@omnisync/store/s3`). */
export class FsObjectStore implements ObjectStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  #path(key: string): string {
    assertObjectKey(key);
    const p = resolve(join(this.#root, key));
    if (!p.startsWith(this.#root + sep)) throw new Error(`object key escapes root: ${key}`);
    return p;
  }

  /** Writes to a temp file in the target directory, so readers never see a partial object. */
  async #temp(path: string, bytes: Uint8Array): Promise<string> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, bytes);
    return tmp;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.#path(key);
    await rename(await this.#temp(path, bytes), path);
  }

  async putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean> {
    const path = this.#path(key);
    const tmp = await this.#temp(path, bytes);
    try {
      // link(2) fails with EEXIST when the name is taken, and otherwise makes the complete file appear at once.
      await link(tmp, path);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.#path(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }
}
