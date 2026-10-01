import { bytesToHex, keyIdOf, type KeyResolver } from "./signing.js";

/**
 * In-memory trusted key set. Phase 0 stand-in for session certificates:
 * Phase 1 replaces registration with certificate validation (issuer, window, revocation).
 */
export class Keyring {
  readonly #keys = new Map<string, Uint8Array>();

  add(publicKey: Uint8Array): Uint8Array {
    const id = keyIdOf(publicKey);
    const hex = bytesToHex(id);
    const existing = this.#keys.get(hex);
    if (existing !== undefined && bytesToHex(existing) !== bytesToHex(publicKey)) {
      throw new Error(`key id collision for ${hex}`);
    }
    this.#keys.set(hex, publicKey.slice());
    return id;
  }

  revoke(keyId: Uint8Array): boolean {
    return this.#keys.delete(bytesToHex(keyId));
  }

  get size(): number {
    return this.#keys.size;
  }

  readonly resolve: KeyResolver = (keyId) => this.#keys.get(bytesToHex(keyId));
}
