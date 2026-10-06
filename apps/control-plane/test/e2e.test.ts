import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ledgerSignerFromKeyPair } from "@omnisync/crypto";
import { CheckpointWriter, Gateway, GatewayClient, exportLedger } from "@omnisync/gateway";
import { decodeFrame, generateKeyPair } from "@omnisync/protocol";
import { verifyLedger } from "@omnisync/verifier";
import {
  MemoryDocumentStore,
  MemoryIdentityStore,
  MemoryObjectStore,
  PgDocumentStore,
  PgIdentityStore,
  migrate,
  type DocumentStore,
  type IdentityStore,
  type LedgerStore,
} from "@omnisync/store";
import { OpenIdLogin } from "../src/index.js";
import { FakeIdp } from "./fake-idp.js";
import { Clock, issuerKey, startPlane, type Plane } from "./helpers.js";

const PG_URL = process.env["OMNISYNC_TEST_DATABASE_URL"];
const kinds = PG_URL ? (["memory", "postgres"] as const) : (["memory"] as const);

const until = async (cond: () => boolean, ms = 5000, what = "condition") => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe.each(kinds)("login to edit, end to end (%s store)", (kind) => {
  let docs: DocumentStore;
  let identity: IdentityStore;
  let cleanup: () => Promise<void>;
  let clock: Clock;
  let plane: Plane;
  let gateway: Gateway;
  let url: string;
  const clients: GatewayClient[] = [];

  beforeEach(async () => {
    clock = new Clock();
    if (kind === "memory") {
      docs = new MemoryDocumentStore();
      identity = new MemoryIdentityStore();
      cleanup = async () => {};
    } else {
      const schema = `e2e_${randomBytes(5).toString("hex")}`;
      const admin = new pg.Pool({ connectionString: PG_URL as string });
      await admin.query(`CREATE SCHEMA ${schema}`);
      const store = new PgDocumentStore({ connectionString: PG_URL as string, schema });
      await migrate(store.pool);
      docs = store;
      identity = new PgIdentityStore(store.pool);
      cleanup = async () => {
        await store.close();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      };
    }
    plane = await startPlane({ adminEmails: ["root@example.com"] }, identity, clock);
    // The gateway is configured with nothing but the issuer's public key and the shared identity database.
    gateway = new Gateway({
      auth: { issuers: [issuerKey.publicKey], identity: plane.identity, now: clock.now, revocationPollMs: 40 },
      store: docs,
      objects: new MemoryObjectStore(),
      sweepMs: 3_600_000,
    });
    url = `ws://127.0.0.1:${await gateway.listen()}`;
  });

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((c) => c.close()));
    await gateway.close();
    await plane.close();
    await cleanup();
  });

  const person = (name: string) => ({ sub: `${name}-sub`, email: `${name}@example.com`, name });
  const device = async (name: string, docId: string) => {
    const s = await plane.login(person(name));
    const { key, res } = await plane.enroll(s.token, s.id);
    const cert = new Uint8Array(Buffer.from(res.json<{ certificate: string }>().certificate, "base64url"));
    const connect = async () => {
      const c = await GatewayClient.connect({
        url,
        docId,
        actor: 1 + Math.floor(Math.random() * 1000),
        key,
        certificate: cert,
        reconnect: false,
        clock: clock.now,
      });
      clients.push(c);
      return c;
    };
    return { ...s, key, cert, serial: res.json<{ serial: string }>().serial, connect };
  };

  it("takes a person from SSO login to a shared, signed, attributable edit, and cuts them off on revocation", async () => {
    // Alice signs in, creates a document, and shares it with Bob as a writer and Rita as a reader.
    const alice = await plane.login(person("alice"));
    const docId = (await plane.call(alice.token, "POST", "/v1/documents")).json<{ id: string }>().id;
    const bobSession = await plane.login(person("bob"));
    const rita = await plane.login(person("rita"));
    await plane.call(alice.token, "PUT", `/v1/documents/${docId}/grants/${bobSession.id}`, { role: "write" });
    await plane.call(alice.token, "PUT", `/v1/documents/${docId}/grants/${rita.id}`, { role: "read" });

    const a = await device("alice", docId);
    const b = await device("bob", docId);
    const r = await device("rita", docId);
    const ac = await a.connect();
    const bc = await b.connect();
    const rc = await r.connect();
    expect([ac.role, bc.role, rc.role]).toEqual(["admin", "write", "read"]);

    await ac.insert(0, "Quarterly report. ");
    await bc.insert(18, "Reviewed by Bob.");
    await until(() => [ac, bc, rc].every((c) => c.doc.getText() === "Quarterly report. Reviewed by Bob."));
    await expect(rc.insert(0, "sneaky")).rejects.toThrow(/forbidden/);

    // Stranger: a valid employee with a certificate but no grant on this document.
    const carol = await device("carol", docId);
    await expect(carol.connect()).rejects.toThrow(/no_access/);

    // Attribution: every stored row names a certificate, which names a person, whose issuance is audited.
    const rows = await docs.readUpdates(docId, 0, 100);
    expect(rows).toHaveLength(2);
    const whoWrote: string[] = [];
    for (const row of rows) {
      const cert = await plane.identity.getCertificate(row.certSerial as Uint8Array);
      expect(Buffer.from(cert?.keyId ?? []).equals(Buffer.from(decodeFrame(row.frame).keyId ?? []))).toBe(true);
      whoWrote.push((await plane.identity.getPrincipal(cert?.principalId ?? ""))?.email ?? "?");
    }
    expect(whoWrote).toEqual(["alice@example.com", "bob@example.com"]);
    const audit = await plane.identity.listAudit(0, 500);
    expect(audit.filter((e) => e.action === "cert.issue").map((e) => e.target)).toEqual(expect.arrayContaining([a.serial, b.serial, r.serial]));

    // The same two edits, checked by someone who trusts only two public keys and has no database.
    const ledgerKey = generateKeyPair(new Uint8Array(32).fill(201));
    await new CheckpointWriter({
      store: docs as unknown as LedgerStore,
      objects: new MemoryObjectStore(),
      tenant: "acme",
      signer: ledgerSignerFromKeyPair(ledgerKey),
      now: clock.now,
    }).flush();
    const lines: string[] = [];
    await exportLedger({ docs: docs as never, identity: plane.identity, tenant: "acme", now: clock.now }, (l) => void lines.push(l));
    const report = await verifyLedger(lines.map((l) => JSON.parse(l) as unknown), { issuers: [issuerKey.publicKey], ledgerKeys: [ledgerKey.publicKey] });
    expect(report.violations).toEqual([]);
    expect(report.counts).toMatchObject({ documents: 1, entries: 2, checkpoints: 1, entriesAfterLastCheckpoint: 0 });

    // Alice revokes Bob's laptop through the API: his open connection dies within a poll interval.
    const org = await plane.login(person("root"));
    expect((await plane.call(org.token, "POST", `/v1/certificates/${b.serial}/revoke`, { reason: "laptop stolen" })).statusCode).toBe(200);
    await until(() => !bc.connected, 3000, "Bob's connection to close");
    await expect(b.connect()).rejects.toThrow(/revoked/);

    // Downgrading Rita's access ends her read access too (she has no write role to lose, so remove it).
    await plane.call(alice.token, "DELETE", `/v1/documents/${docId}/grants/${rita.id}`);
    await until(() => !rc.connected, 3000, "Rita's connection to close");

    // Alice keeps working; nothing Bob or Rita did after revocation reached the log.
    await ac.insert(0, "Final: ");
    expect(await docs.headSeq(docId)).toBe(3);
  });

  it("disabling a person ends every device they own at once", async () => {
    const alice = await plane.login(person("alice"));
    const docId = (await plane.call(alice.token, "POST", "/v1/documents")).json<{ id: string }>().id;
    const bobSession = await plane.login(person("bob"));
    await plane.call(alice.token, "PUT", `/v1/documents/${docId}/grants/${bobSession.id}`, { role: "write" });
    const laptop = await device("bob", docId);
    const phone = await plane.enroll(bobSession.token, bobSession.id);
    expect(phone.res.statusCode).toBe(201);
    const bc = await laptop.connect();

    const org = await plane.login(person("root"));
    const res = await plane.call(org.token, "POST", `/v1/principals/${bobSession.id}/disable`);
    expect(res.json()).toEqual({ certificatesRevoked: 2 }); // laptop and phone
    await until(() => !bc.connected, 3000, "Bob's connection to close");
    await expect(laptop.connect()).rejects.toThrow(/revoked/);
  });
});

describe("pending logins", () => {
  it("expire and stay bounded", async () => {
    const idp = await new FakeIdp("c").start();
    let t = 0;
    const login = new OpenIdLogin({ issuerUrl: idp.issuer, clientId: "c", redirectUri: "http://x/cb", allowInsecureHttp: true }, () => t);
    try {
      await login.begin();
      await login.begin();
      expect(login.pendingCount).toBe(2);
      t += 11 * 60_000;
      await login.begin(); // sweeps the two expired entries
      expect(login.pendingCount).toBe(1);
    } finally {
      await idp.stop();
    }
  });
});
