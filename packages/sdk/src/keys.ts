import { generateKeyPair, keyIdOf, signDetached } from "@omnisync/protocol";

/**
 * The key that signs every edit and proves possession of the session certificate.
 * `extractable` is false when the secret never enters JavaScript memory (WebCrypto).
 */
export interface DeviceKey {
  readonly keyId: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly extractable: boolean;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/** What a vault keeps: the CryptoKey object itself (structured clone), never raw secret bytes. */
export interface KeyRecord {
  readonly privateKey: CryptoKey;
  readonly publicKey: Uint8Array;
}

export interface KeyVault {
  load(): Promise<KeyRecord | undefined>;
  store(record: KeyRecord): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryKeyVault implements KeyVault {
  #record: KeyRecord | undefined;
  load(): Promise<KeyRecord | undefined> {
    return Promise.resolve(this.#record);
  }
  store(record: KeyRecord): Promise<void> {
    this.#record = record;
    return Promise.resolve();
  }
  clear(): Promise<void> {
    this.#record = undefined;
    return Promise.resolve();
  }
}

const KEY_STORE = "keys";
const KEY_NAME = "device";

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("indexeddb request failed"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexeddb transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("indexeddb transaction aborted"));
  });
}

/** Stores the CryptoKey in IndexedDB. A non-extractable key survives reloads and still cannot be read by any script. */
export class IndexedDbKeyVault implements KeyVault {
  readonly #name: string;
  readonly #idb: IDBFactory;
  #db: Promise<IDBDatabase> | undefined;

  constructor(opts: { name?: string; indexedDB?: IDBFactory } = {}) {
    this.#name = opts.name ?? "omnisync-keys";
    this.#idb = opts.indexedDB ?? globalThis.indexedDB;
  }

  #open(): Promise<IDBDatabase> {
    this.#db ??= new Promise((resolve, reject) => {
      const req = this.#idb.open(this.#name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(KEY_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("cannot open key vault"));
    });
    return this.#db;
  }

  async load(): Promise<KeyRecord | undefined> {
    const db = await this.#open();
    const v = (await request(db.transaction(KEY_STORE, "readonly").objectStore(KEY_STORE).get(KEY_NAME))) as
      | { privateKey: CryptoKey; publicKey: Uint8Array }
      | undefined;
    if (!v?.privateKey || !(v.publicKey instanceof Uint8Array) || v.publicKey.length !== 32) return undefined;
    return { privateKey: v.privateKey, publicKey: v.publicKey };
  }

  async store(record: KeyRecord): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction(KEY_STORE, "readwrite");
    tx.objectStore(KEY_STORE).put({ privateKey: record.privateKey, publicKey: record.publicKey }, KEY_NAME);
    await done(tx);
  }

  async clear(): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction(KEY_STORE, "readwrite");
    tx.objectStore(KEY_STORE).delete(KEY_NAME);
    await done(tx);
  }

  close(): void {
    void this.#db?.then((db) => db.close());
    this.#db = undefined;
  }
}

export interface CreateDeviceKeyOptions {
  vault?: KeyVault;
  /** Injectable for tests. Defaults to `globalThis.crypto`. */
  webCrypto?: Crypto;
  /** Refuse the in-memory fallback when WebCrypto cannot hold an Ed25519 key. */
  requireNonExtractable?: boolean;
}

/** Why the key is not (or could not be) non-extractable, for the caller to show. */
export class NonExtractableUnavailableError extends Error {
  override readonly name = "NonExtractableUnavailableError";
  constructor() {
    super("this browser cannot hold a non-extractable Ed25519 key");
  }
}

function fromCryptoKey(privateKey: CryptoKey, publicKey: Uint8Array, subtle: SubtleCrypto): DeviceKey {
  if (privateKey.extractable) throw new Error("vault returned an extractable key where a non-extractable one was expected");
  return {
    keyId: keyIdOf(publicKey),
    publicKey,
    extractable: false,
    async sign(message) {
      const sig = new Uint8Array(await subtle.sign({ name: "Ed25519" }, privateKey, message as BufferSource));
      if (sig.length !== 64) throw new Error("WebCrypto returned a signature of the wrong length");
      return sig;
    },
  };
}

/**
 * Returns the stored key if the vault has one, else makes one. A WebCrypto Ed25519 key created with
 * `extractable: false` is preferred; otherwise a noble key held in memory for the page's lifetime
 * (never written anywhere by the SDK), reported through `extractable: true`.
 */
export async function createDeviceKey(opts: CreateDeviceKeyOptions = {}): Promise<DeviceKey> {
  const vault = opts.vault;
  const wc = opts.webCrypto ?? globalThis.crypto;
  const subtle = wc?.subtle;

  const stored = subtle ? await vault?.load() : undefined;
  if (stored && subtle) return fromCryptoKey(stored.privateKey, stored.publicKey, subtle);

  if (subtle) {
    try {
      const pair = (await subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
      const publicKey = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
      if (publicKey.length === 32) {
        await vault?.store({ privateKey: pair.privateKey, publicKey });
        return fromCryptoKey(pair.privateKey, publicKey, subtle);
      }
    } catch (e) {
      if (e instanceof Error && e.name === "DataCloneError") throw e; // a vault that cannot store the key is a real fault
      // Ed25519 is not supported by this WebCrypto: fall through.
    }
  }
  if (opts.requireNonExtractable) throw new NonExtractableUnavailableError();

  const pair = generateKeyPair();
  return {
    keyId: pair.keyId,
    publicKey: pair.publicKey,
    extractable: true,
    sign: (message) => Promise.resolve(signDetached(message, pair.secretKey)),
  };
}
