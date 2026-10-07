import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { bytesToHex, generateKeyPair, hexToBytes, keyIdOf, signDetached, signUpdate, signUpdateWith, verifyDetached } from "@omnisync/protocol";
import { encodeAuthResponse, encodeAuthResponseWith } from "@omnisync/crypto";
import { IndexedDbKeyVault, MemoryKeyVault, NonExtractableUnavailableError, createDeviceKey } from "../src/keys.js";

const noEd25519 = {
  subtle: {
    generateKey: () => Promise.reject(new DOMException("unsupported", "NotSupportedError")),
  },
} as unknown as Crypto;

describe("device key", () => {
  it("prefers a WebCrypto key that cannot be exported", async () => {
    const key = await createDeviceKey({ vault: new MemoryKeyVault() });
    expect(key.extractable).toBe(false);
    expect(key.publicKey).toHaveLength(32);
    expect(bytesToHex(key.keyId)).toBe(bytesToHex(keyIdOf(key.publicKey)));
  });

  it("signs so that the gateway's verifier accepts it, and the signature matches the secret-key path byte for byte", async () => {
    const key = await createDeviceKey();
    const msg = new TextEncoder().encode("hello");
    const sig = await key.sign(msg);
    expect(verifyDetached(sig, msg, key.publicKey)).toBe(true);

    // Same bytes as the in-memory signer would give for a known seed (Ed25519 is deterministic).
    const seed = hexToBytes("0101010101010101010101010101010101010101010101010101010101010101");
    const pair = generateKeyPair(seed);
    const input = { docId: "d", sessionId: 7, seq: 1, claimedAtMs: 1000, payload: Uint8Array.of(1, 2, 3) };
    const viaCallback = await signUpdateWith(input, pair.keyId, (m) => Promise.resolve(signDetachedLike(m, pair)));
    expect(bytesToHex(viaCallback)).toBe(bytesToHex(signUpdate(input, pair)));
  });

  it("proves possession to the AUTH handshake the same way as a secret key would", async () => {
    const pair = generateKeyPair(hexToBytes("0202020202020202020202020202020202020202020202020202020202020202"));
    const cert = Uint8Array.of(9, 9, 9);
    const nonce = new Uint8Array(32).fill(5);
    const a = encodeAuthResponse(cert, pair.secretKey, "doc", nonce);
    const b = await encodeAuthResponseWith(cert, (m) => Promise.resolve(signDetachedLike(m, pair)), "doc", nonce);
    expect(bytesToHex(b)).toBe(bytesToHex(a));
  });

  it("refuses to export a non-extractable key by any route", async () => {
    const vault = new MemoryKeyVault();
    await createDeviceKey({ vault });
    const rec = await vault.load();
    expect(rec?.privateKey.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey("pkcs8", rec!.privateKey)).rejects.toThrow();
    await expect(globalThis.crypto.subtle.exportKey("jwk", rec!.privateKey)).rejects.toThrow();
    await expect(globalThis.crypto.subtle.exportKey("raw", rec!.privateKey)).rejects.toThrow();
  });

  it("reuses the stored key: the same public key after a 'reload'", async () => {
    const vault = new MemoryKeyVault();
    const first = await createDeviceKey({ vault });
    const second = await createDeviceKey({ vault });
    expect(bytesToHex(second.publicKey)).toBe(bytesToHex(first.publicKey));
    const msg = Uint8Array.of(1);
    expect(bytesToHex(await second.sign(msg))).toBe(bytesToHex(await first.sign(msg)));
  });

  it("keeps the key across IndexedDB reopen, still non-extractable", async () => {
    const idb = new IDBFactory();
    const v1 = new IndexedDbKeyVault({ name: "k", indexedDB: idb });
    const first = await createDeviceKey({ vault: v1 });
    v1.close();
    const v2 = new IndexedDbKeyVault({ name: "k", indexedDB: idb });
    const second = await createDeviceKey({ vault: v2 });
    expect(second.extractable).toBe(false);
    expect(bytesToHex(second.publicKey)).toBe(bytesToHex(first.publicKey));
    expect(verifyDetached(await second.sign(Uint8Array.of(4, 5)), Uint8Array.of(4, 5), first.publicKey)).toBe(true);
    await v2.clear();
    expect(await v2.load()).toBeUndefined();
  });

  it("falls back to an in-memory noble key and says so", async () => {
    const vault = new MemoryKeyVault();
    const key = await createDeviceKey({ vault, webCrypto: noEd25519 });
    expect(key.extractable).toBe(true);
    expect(await vault.load()).toBeUndefined(); // a fallback key is never written down
    const msg = Uint8Array.of(7);
    expect(verifyDetached(await key.sign(msg), msg, key.publicKey)).toBe(true);
  });

  it("refuses a vault that hands back an extractable key", async () => {
    const vault = new MemoryKeyVault();
    const pair = (await globalThis.crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    await vault.store({ privateKey: pair.privateKey, publicKey: new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", pair.publicKey)) });
    await expect(createDeviceKey({ vault })).rejects.toThrow(/extractable/);
  });

  it("does not trust a signer that returns the wrong number of bytes", async () => {
    const vault = new MemoryKeyVault();
    await createDeviceKey({ vault });
    const lying = { subtle: { sign: () => Promise.resolve(new ArrayBuffer(10)) } } as unknown as Crypto;
    const key = await createDeviceKey({ vault, webCrypto: lying });
    await expect(key.sign(Uint8Array.of(1))).rejects.toThrow(/wrong length/);
  });

  it("can refuse the fallback", async () => {
    await expect(createDeviceKey({ webCrypto: noEd25519, requireNonExtractable: true })).rejects.toBeInstanceOf(NonExtractableUnavailableError);
  });

  it("ignores a damaged vault record", async () => {
    const idb = new IDBFactory();
    const vault = new IndexedDbKeyVault({ name: "bad", indexedDB: idb });
    await new Promise<void>((resolve, reject) => {
      const r = idb.open("bad", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("keys");
      r.onsuccess = () => {
        const tx = r.result.transaction("keys", "readwrite");
        tx.objectStore("keys").put({ privateKey: "nope", publicKey: new Uint8Array(3) }, "device");
        tx.oncomplete = () => {
          r.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    expect(await vault.load()).toBeUndefined();
  });
});

function signDetachedLike(m: Uint8Array, pair: { secretKey: Uint8Array }): Uint8Array {
  return signDetached(m, pair.secretKey);
}
