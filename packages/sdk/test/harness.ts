import { issueCertificate, signerFromKeyPair } from "@omnisync/crypto";
import { yjsEngine } from "@omnisync/engine/yjs";
import { Gateway } from "@omnisync/gateway";
import { generateKeyPair, signUpdateWith } from "@omnisync/protocol";
import { MemoryDocumentStore, MemoryIdentityStore, MemoryObjectStore, type Principal, type Role } from "@omnisync/store";
import type { DeviceKey } from "../src/keys.js";

export const HOUR = 3_600_000;
export const issuerKey = generateKeyPair(new Uint8Array(32).fill(200));

export const until = async (cond: () => boolean | Promise<boolean>, ms = 5000, what = "condition") => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A controllable clock shared by the gateway and the SDK under test. */
export class TestClock {
  constructor(public t = Date.now()) {}
  readonly now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export class World {
  readonly store = new MemoryDocumentStore();
  readonly objects = new MemoryObjectStore();
  readonly identity = new MemoryIdentityStore();
  readonly clock: TestClock;
  readonly running: Gateway[] = [];
  #n = 0;
  constructor(clock = new TestClock()) {
    this.clock = clock;
  }

  async start(opts: { port?: number; useTestClock?: boolean } = {}): Promise<{ gateway: Gateway; url: string; port: number }> {
    const gateway = new Gateway({
      store: this.store,
      objects: this.objects,
      sweepMs: 3_600_000,
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      auth: { issuers: [issuerKey.publicKey], identity: this.identity, revocationPollMs: 3_600_000, ...(opts.useTestClock ? { now: this.clock.now } : {}) },
    });
    const port = await gateway.listen();
    this.running.push(gateway);
    return { gateway, url: `ws://127.0.0.1:${port}`, port };
  }

  person(name: string): Promise<Principal> {
    return this.identity.upsertPrincipal(
      { oidcIssuer: "https://idp.test", oidcSubject: name, email: `${name}@test`, displayName: name, orgRole: "member" },
      { atMs: this.clock.t, actor: "system", action: "auth.login", target: "" },
    );
  }

  /** Issues a certificate for the device key and grants roles, as the control plane would. */
  async enroll(
    principal: Principal,
    key: DeviceKey,
    grants: Record<string, Role> = {},
    opts: { lifetimeMs?: number; notBeforeMs?: number } = {},
  ): Promise<{ certificate: Uint8Array; serial: Uint8Array }> {
    const issuedAtMs = this.clock.t;
    const notBeforeMs = opts.notBeforeMs ?? issuedAtMs;
    const notAfterMs = notBeforeMs + (opts.lifetimeMs ?? 12 * HOUR);
    const serial = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const certificate = issueCertificate({ subject: principal.id, subjectPublicKey: key.publicKey, issuedAtMs, notBeforeMs, notAfterMs, serial }, signerFromKeyPair(issuerKey));
    await this.identity.recordCertificate(
      { serial, principalId: principal.id, keyId: key.keyId, publicKey: key.publicKey, issuedAtMs, notBeforeMs, notAfterMs, certificate },
      { atMs: issuedAtMs, actor: "system", action: "cert.issue", target: principal.id },
    );
    for (const [doc, role] of Object.entries(grants)) {
      await this.identity.setGrant(doc, principal.id, role, "system", this.clock.t, { atMs: this.clock.t, actor: "system", action: "grant.set", target: `${doc}:${principal.id}` });
    }
    return { certificate, serial };
  }

  revoke(serial: Uint8Array): Promise<boolean> {
    return this.identity.revokeCertificate(serial, this.clock.t, "test", { atMs: this.clock.t, actor: "system", action: "cert.revoke", target: "" });
  }

  async cleanup(): Promise<void> {
    await Promise.allSettled(this.running.splice(0).map((g) => g.close()));
  }

  nextName(): string {
    return `user${this.#n++}`;
  }
}

/** A signed UPDATE frame for a given session and seq, as a page from an earlier load would have stored it. */
export async function craftFrame(key: DeviceKey, docId: string, sessionId: number, seq: number, claimedAtMs: number, text = "x") {
  const d = yjsEngine.create(1000 + seq);
  const payload = d.insertText(0, text);
  d.destroy();
  const bytes = await signUpdateWith({ docId, sessionId, seq, claimedAtMs, payload }, key.keyId, (m) => key.sign(m));
  return { sessionId, seq, bytes, claimedAtMs };
}
