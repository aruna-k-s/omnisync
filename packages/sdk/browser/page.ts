/** The page the Playwright test loads: the real SDK in a real browser, driven through `window.omni`. */
import { IndexedDbKeyVault, OmniSyncClient, createDeviceKey, enroll, type DeviceKey, type SyncDocument } from "../src/index.js";

const vault = new IndexedDbKeyVault({ name: "omnisync-keys" });
let key: DeviceKey | undefined;
let client: OmniSyncClient | undefined;
let doc: SyncDocument | undefined;

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const toB64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const need = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new Error(`${what} first`);
  return v;
};

const api = {
  async init() {
    key = await createDeviceKey({ vault, requireNonExtractable: true });
    return { publicKeyHex: hex(key.publicKey), extractable: key.extractable };
  },
  async enroll(controlPlaneUrl: string, sessionToken: string) {
    const e = await enroll({ controlPlaneUrl, sessionToken, deviceKey: need(key, "init") });
    localStorage.setItem("omnisync-cert", toB64(e.certificate));
  },
  async open(url: string, docId: string) {
    const cert = localStorage.getItem("omnisync-cert");
    client = new OmniSyncClient({
      url,
      key: need(key, "init"),
      ...(cert ? { certificate: fromB64(cert) } : {}),
      tuning: { batch: { minMs: 50, maxMs: 250 }, backoff: { baseMs: 100, maxMs: 1000 }, syncTimeoutMs: 3000 },
    });
    doc = await client.open(docId);
    return { sessionId: doc.sessionId, pending: doc.pending, text: doc.text, warnings: client.warnings };
  },
  state() {
    const d = need(doc, "open");
    return { text: d.text, data: d.data, status: d.status, pending: d.pending, extractable: need(key, "init").extractable, errors: d.errors, refused: d.refusedEdits };
  },
  insertText(index: number, text: string) {
    need(doc, "open").insertText(index, text);
  },
  mapSet(path: (string | number)[], k: string, value: unknown) {
    need(doc, "open").mapSet(path, k, value as never);
  },
  arrayInsert(path: (string | number)[], index: number, values: unknown[]) {
    need(doc, "open").arrayInsert(path, index, values as never[]);
  },
  flush: () => need(doc, "open").flush(),
  synced: () => need(doc, "open").synced(),
  /** Whatever a hostile script on this page could try to do with the device key. */
  async tryExport() {
    const rec = await vault.load();
    if (!rec) return { stored: false as const };
    const out: Record<string, string> = {};
    for (const fmt of ["pkcs8", "raw", "jwk"] as const) {
      try {
        await crypto.subtle.exportKey(fmt, rec.privateKey);
        out[fmt] = "EXPORTED";
      } catch (e) {
        out[fmt] = (e as Error).name;
      }
    }
    return { stored: true as const, extractable: rec.privateKey.extractable, results: out };
  },
};

(window as unknown as { omni: typeof api }).omni = api;
