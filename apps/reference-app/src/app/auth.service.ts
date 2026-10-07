import { Injectable, signal } from "@angular/core";
import { DeviceLoginError, IndexedDbKeyVault, OmniSyncClient, createDeviceKey, decideDeviceRequest, describeDeviceRequest, enroll, loginUrl, returnToOf, sessionFromHash, type DeviceKey, type DeviceRequestInfo, type SyncDocument } from "@omnisync/sdk";
import { parseConfig, type AppConfig } from "./config.js";
import { reusableCertificate, storedCert } from "./cert-cache.js";
import { deviceCodeFromSearch, removeDeviceParam } from "./device-code.js";
import { Recent } from "./recent.js";

export interface Me {
  id: string;
  email: string;
  displayName: string;
}

const DEVICE_SLOT = "omnisync-reference-device";
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const toB64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Signed-in state and the device behind it: the control-plane session (in memory only), the device key (WebCrypto,
 * non-extractable where the browser allows), its certificate (kept in local storage, it is useless without the key)
 * and the SDK client that opens workbooks.
 */
@Injectable({ providedIn: "root" })
export class AppSession {
  readonly ready = signal(false);
  readonly me = signal<Me | undefined>(undefined);
  readonly notice = signal<string | undefined>(undefined);
  /** `false`: the device key cannot be read by any script on this page. `true`: the fallback, held in memory. */
  readonly keyExtractable = signal<boolean | undefined>(undefined);
  readonly warnings = signal<string[]>([]);
  readonly recent = new Recent(storage());
  /** A device that asked, through `?device=`, to be signed in; kept across the sign-in redirect. */
  readonly pendingDevice = signal<string | undefined>(undefined);
  #config!: AppConfig;
  #token: string | undefined;
  #key: DeviceKey | undefined;
  #client: OmniSyncClient | undefined;

  async start(): Promise<void> {
    try {
      const res = await fetch("config.json", { cache: "no-store" });
      this.#config = parseConfig(await res.json());
    } catch (e) {
      this.notice.set(`Configuration error: ${e instanceof Error ? e.message : String(e)}`);
      this.ready.set(true);
      return;
    }
    const fromUrl = deviceCodeFromSearch(location.search);
    if (fromUrl) {
      // The code is not secret, but it should not stay in the address bar, and sign-in sends the browser away and back.
      history.replaceState(null, "", location.pathname + removeDeviceParam(location.search) + location.hash);
      try {
        globalThis.sessionStorage.setItem(DEVICE_SLOT, fromUrl);
      } catch {
        // storage blocked: the code survives only if the person is already signed in
      }
    }
    this.pendingDevice.set(fromUrl ?? this.#storedDevice());
    const token = sessionFromHash(location.hash);
    if (token) {
      // Out of the address bar and the history before anything else can read or copy it.
      history.replaceState(null, "", location.pathname + location.search);
      this.#token = token;
      await this.#setUp();
    }
    this.ready.set(true);
  }

  #storedDevice(): string | undefined {
    try {
      return deviceCodeFromSearch(`?device=${globalThis.sessionStorage.getItem(DEVICE_SLOT) ?? ""}`);
    } catch {
      return undefined;
    }
  }

  clearDevice(): void {
    this.pendingDevice.set(undefined);
    try {
      globalThis.sessionStorage.removeItem(DEVICE_SLOT);
    } catch {
      // nothing stored
    }
  }

  /** A call to the device-login routes with this session; a 401 ends the session like any other call. */
  async #deviceCall<T>(f: (cp: string, token: string) => Promise<T>): Promise<T> {
    try {
      return await f(this.#config.controlPlane, this.#token ?? "");
    } catch (e) {
      if (e instanceof DeviceLoginError && e.status === 401) {
        await this.signOut("Your session ended. Sign in again.");
        throw new Error("signed out", { cause: e });
      }
      throw e;
    }
  }
  describeDevice(code: string): Promise<DeviceRequestInfo> {
    return this.#deviceCall((cp, token) => describeDeviceRequest(cp, token, code));
  }
  decideDevice(code: string, decision: "approve" | "deny"): Promise<void> {
    return this.#deviceCall((cp, token) => decideDeviceRequest(cp, token, code, decision));
  }

  signIn(): void {
    location.assign(loginUrl(this.#config.controlPlane, { returnTo: returnToOf(location) }));
  }

  async signOut(message?: string): Promise<void> {
    this.#token = undefined;
    this.me.set(undefined);
    this.notice.set(message);
    const c = this.#client;
    this.#client = undefined;
    await c?.close();
  }

  async #call(method: string, path: string): Promise<Response> {
    const res = await fetch(`${this.#config.controlPlane}${path}`, { method, headers: { authorization: `Bearer ${this.#token ?? ""}` } });
    if (res.status === 401) {
      await this.signOut("Your session ended. Sign in again.");
      throw new Error("signed out");
    }
    return res;
  }

  async #setUp(): Promise<void> {
    try {
      const me = await this.#call("GET", "/v1/me");
      if (!me.ok) throw new Error(`cannot read your profile (${me.status})`);
      const profile = (await me.json()) as Me;
      this.#key = await createDeviceKey({ vault: new IndexedDbKeyVault({ name: "omnisync-reference-keys" }) });
      this.keyExtractable.set(this.#key.extractable);
      const certificate = await this.#certificate(profile.id, this.#key);
      this.#client = new OmniSyncClient({
        url: this.#config.gateway,
        key: this.#key,
        certificate,
        tuning: { onCertificateExpiring: () => void this.#renew(profile.id) },
      });
      this.warnings.set(this.#client.warnings);
      this.me.set(profile);
    } catch (e) {
      if (!this.#token) return; // signed out meanwhile; the notice is already set
      this.notice.set(`Sign-in failed: ${e instanceof Error ? e.message : String(e)}`);
      this.#token = undefined;
    }
  }

  /** A certificate for this device key: the stored one if it is ours and has time left, else a fresh one. */
  async #certificate(principalId: string, key: DeviceKey): Promise<Uint8Array> {
    const slot = `omnisync-reference-cert:${principalId}`;
    try {
      const reusable = reusableCertificate(storage()?.getItem(slot) ?? null, hex(key.publicKey), Date.now());
      if (reusable !== undefined) return fromB64(reusable);
    } catch {
      // storage unreadable or the stored value is not base64: enroll again
    }
    const e = await enroll({ controlPlaneUrl: this.#config.controlPlane, sessionToken: this.#token ?? "", deviceKey: key, principalId });
    try {
      storage()?.setItem(slot, storedCert(hex(key.publicKey), toB64(e.certificate), e.notAfterMs));
    } catch {
      // storage blocked: the certificate lives for this page only
    }
    return e.certificate;
  }

  async #renew(principalId: string): Promise<void> {
    if (!this.#key || !this.#client || !this.#token) return; // signed out: nothing to renew with
    try {
      storage()?.removeItem(`omnisync-reference-cert:${principalId}`);
      this.#client.setCertificate(await this.#certificate(principalId, this.#key));
    } catch {
      // The session ended or the control plane is away; the document shows "closed" when the certificate lapses.
    }
  }

  async createDocument(): Promise<string> {
    const res = await this.#call("POST", "/v1/documents");
    if (!res.ok) throw new Error(`could not create a workbook (${res.status})`);
    return ((await res.json()) as { id: string }).id;
  }

  open(docId: string): Promise<SyncDocument> {
    if (!this.#client) throw new Error("not signed in");
    return this.#client.open(docId);
  }
}
