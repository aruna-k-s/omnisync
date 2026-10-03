import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { getEngine } from "@omnisync/engine";
import { encodeAuthResponse, issueCertificate, signerFromKeyPair } from "@omnisync/crypto";
import { FrameType, decodeFrame, encodeFrame, generateKeyPair, signUpdate, type Frame } from "@omnisync/protocol";
import type { GatewayClient } from "../src/index.js";
import { Gateway } from "../src/index.js";
import {
  HOUR,
  PG_URL,
  T0,
  TestClock,
  TestIdentity,
  connectAs,
  issuerKey,
  makeWorld,
  startGateway,
  until,
  type Enrolled,
  type Running,
  type StoreKind,
  type World,
} from "./harness.js";
import { MemoryDocumentStore } from "@omnisync/store";

const kinds: StoreKind[] = PG_URL ? ["memory", "postgres"] : ["memory"];

/** A socket that speaks raw frames, to forge handshakes a real client never would. */
function rawSocket(url: string, docId = "doc") {
  const ws = new WebSocket(`${url}/doc/${docId}`);
  const frames: Frame[] = [];
  const state: { closed?: { code: number; reason: string } } = {};
  ws.on("message", (d: Buffer) => frames.push(decodeFrame(new Uint8Array(d))));
  ws.on("close", (code, reason) => (state.closed = { code, reason: reason.toString() }));
  ws.on("error", () => {});
  return {
    ws,
    frames,
    state,
    nonce: async () => {
      await until(() => frames.length > 0, 3000, "AUTH_CHALLENGE");
      return (frames[0] as Frame).payload;
    },
    send: (f: Parameters<typeof encodeFrame>[0]) => ws.send(encodeFrame(f)),
    sendAuth(payload: Uint8Array) {
      ws.send(encodeFrame({ type: FrameType.AUTH_RESPONSE, flags: 0, sessionId: 0, seq: 0, payload }));
    },
    closed: async () => {
      await until(() => state.closed !== undefined, 3000, "close");
      return state.closed as { code: number; reason: string };
    },
    errors: () => frames.filter((f) => f.type === FrameType.ERROR).map((f) => new TextDecoder().decode(f.payload)),
  };
}

describe.each(kinds)("gateway identity on %s store", (kind) => {
  let world: World;
  let clock: TestClock;
  let ids: TestIdentity;
  const running: Running[] = [];
  const clients: GatewayClient[] = [];
  const sockets: WebSocket[] = [];

  const start = async (auth: Record<string, unknown> = {}) => {
    const r = await startGateway(world, {
      auth: { issuers: [issuerKey.publicKey], identity: world.identity, now: clock.now, revocationPollMs: 3_600_000, ...auth },
    });
    running.push(r);
    return r;
  };
  const connect = async (r: Running, e: Enrolled, docId = "doc") => {
    const c = await connectAs(r.url, e, clock, { docId });
    clients.push(c);
    return c;
  };
  const raw = (r: Running, docId = "doc") => {
    const s = rawSocket(r.url, docId);
    sockets.push(s.ws);
    return s;
  };
  const authRaw = async (s: ReturnType<typeof rawSocket>, e: Enrolled, docId = "doc", cert = e.certificate) => {
    s.sendAuth(encodeAuthResponse(cert, e.key.secretKey, docId, await s.nonce()));
  };

  beforeEach(async () => {
    world = await makeWorld(kind);
    clock = new TestClock();
    ids = new TestIdentity(world.identity, clock);
  });

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    await Promise.allSettled(clients.splice(0).map((c) => c.close()));
    await Promise.allSettled(running.splice(0).map((r) => r.gateway.close()));
    await world.cleanup();
  });

  it("admits certificate holders, converges them, and records the signing certificate in the log", async () => {
    const alice = await ids.enroll("alice", { doc: "write" });
    const bob = await ids.enroll("bob", { doc: "write" });
    const r = await start();
    const a = await connect(r, alice);
    const b = await connect(r, bob);
    expect(a.role).toBe("write");
    expect(a.mode).toBe("full");
    await a.insert(0, "hello");
    await b.insert(5, " world");
    await until(() => a.doc.getText() === "hello world" && b.doc.getText() === "hello world");

    const rows = await world.rawStore.readUpdates("doc", 0, 10);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const frame = decodeFrame(row.frame);
      const cert = await world.identity.getCertificate(row.certSerial as Uint8Array);
      expect(cert).toBeDefined(); // invariant 8: every row names a certificate we can look up
      expect([...(cert?.keyId ?? [])]).toEqual([...(frame.keyId ?? [])]);
      expect(frame.claimedAtMs).toBe(T0);
    }
    expect(r.gateway.stats.authenticated).toBe(2);
  });

  it("does nothing for a stranger: no frame but AUTH_RESPONSE is accepted, and no document is loaded", async () => {
    await ids.enroll("alice", { doc: "write" });
    const r = await start();
    const s = raw(r);
    await s.nonce();
    s.send({ type: FrameType.SYNC_1, flags: 0, sessionId: 1, seq: 0, payload: new Uint8Array() });
    expect((await s.closed()).code).toBe(4401);
    expect(r.gateway.isResident("doc")).toBe(false);
    expect(r.gateway.stats.authFailures["unauthenticated"]).toBe(1);
  });

  it("closes a connection that never answers the challenge", async () => {
    const r = await start({ authTimeoutMs: 80 });
    const s = raw(r);
    const closed = await s.closed();
    expect(closed).toEqual({ code: 4401, reason: "timeout" });
    expect(r.gateway.isResident("doc")).toBe(false);
  });

  it("refuses forged, unknown, revoked, unauthorised, early and long-expired certificates, each with its own reason", async () => {
    const alice = await ids.enroll("alice", { doc: "write" });
    const r = await start();
    const fail = async (e: Enrolled, cert = e.certificate, docId = "doc") => {
      const s = raw(r, docId);
      await authRaw(s, e, docId, cert);
      const closed = await s.closed();
      expect(s.errors()).toEqual([`auth_failed;${closed.reason}`]);
      expect(s.frames.some((f) => f.type === FrameType.AUTH_RESULT)).toBe(false);
      return closed;
    };

    // Certificate signed by a key the gateway does not trust.
    const rogue = generateKeyPair(new Uint8Array(32).fill(150));
    const forged = issueCertificate(
      { subject: alice.principal.id, subjectPublicKey: alice.key.publicKey, issuedAtMs: T0, notAfterMs: T0 + HOUR },
      signerFromKeyPair(rogue),
    );
    expect(await fail(alice, forged)).toEqual({ code: 4401, reason: "untrusted_issuer" });

    // Valid signature, but the control plane never recorded it.
    const unrecorded = issueCertificate(
      { subject: alice.principal.id, subjectPublicKey: alice.key.publicKey, issuedAtMs: T0, notAfterMs: T0 + HOUR },
      signerFromKeyPair(issuerKey),
    );
    expect(await fail(alice, unrecorded)).toEqual({ code: 4401, reason: "bad_certificate" });

    // Proof made with a different secret key than the certificate vouches for.
    const thief = { ...alice, key: generateKeyPair(new Uint8Array(32).fill(151)) };
    expect(await fail(thief)).toEqual({ code: 4401, reason: "bad_proof" });

    // No role on this document.
    const carol = await ids.enroll("carol", { other: "write" });
    expect(await fail(carol)).toEqual({ code: 4403, reason: "no_access" });

    // Revoked.
    const dave = await ids.enroll("dave", { doc: "write" });
    await ids.revoke(dave);
    expect(await fail(dave)).toEqual({ code: 4401, reason: "revoked" });

    // Not valid yet (more than the allowed skew ahead of the gateway clock).
    const early = await ids.enroll("erin", { doc: "write" }, { notBeforeMs: T0 + HOUR });
    expect(await fail(early)).toEqual({ code: 4401, reason: "not_yet_valid" });

    // Past expiry and past the grace window.
    const old = await ids.enroll("frank", { doc: "write" }, { lifetimeMs: HOUR });
    clock.advance(HOUR + 72 * HOUR + 1);
    expect(await fail(old)).toEqual({ code: 4401, reason: "expired" });

    expect(r.gateway.stats.authenticated).toBe(0);
    expect(await world.rawStore.headSeq("doc")).toBe(0);
  });

  it("binds each handshake to its connection and its document, so a captured response is useless", async () => {
    const alice = await ids.enroll("alice", { doc: "write", other: "write" });
    const r = await start();

    // Capture a valid response from one connection and replay it on a fresh one (new nonce).
    const first = raw(r);
    const captured = encodeAuthResponse(alice.certificate, alice.key.secretKey, "doc", await first.nonce());
    first.sendAuth(captured);
    await until(() => first.frames.some((f) => f.type === FrameType.AUTH_RESULT));
    const second = raw(r);
    await second.nonce();
    second.sendAuth(captured);
    expect(await second.closed()).toEqual({ code: 4401, reason: "bad_proof" });

    // A proof for another document does not open this one, though alice may read both.
    const third = raw(r, "doc");
    third.sendAuth(encodeAuthResponse(alice.certificate, alice.key.secretKey, "other", await third.nonce()));
    expect(await third.closed()).toEqual({ code: 4401, reason: "bad_proof" });
  });

  it("lets a reader read and refuses its writes, storing nothing", async () => {
    const alice = await ids.enroll("alice", { doc: "write" });
    const rita = await ids.enroll("rita", { doc: "read" });
    const r = await start();
    const a = await connect(r, alice);
    const reader = await connect(r, rita);
    expect(reader.role).toBe("read");
    await a.insert(0, "visible");
    await until(() => reader.doc.getText() === "visible");

    const p = reader.insert(0, "nope");
    await expect(p).rejects.toThrow(/forbidden/);
    expect(await world.rawStore.headSeq("doc")).toBe(1);
    expect(a.doc.getText()).toBe("visible");
    expect(r.gateway.stats.rejected["forbidden"]).toBe(1);
  });

  it("only accepts updates signed by the key in the connection's own certificate", async () => {
    const alice = await ids.enroll("alice", { doc: "write" });
    const bob = await ids.enroll("bob", { doc: "write" });
    const r = await start();
    const s = raw(r);
    await authRaw(s, alice);
    await until(() => s.frames.some((f) => f.type === FrameType.AUTH_RESULT));
    // Bob is a legitimate user, but this is Alice's connection.
    const frame = signUpdate({ docId: "doc", sessionId: 1, seq: 1, claimedAtMs: T0, payload: new Uint8Array([0]) }, bob.key);
    s.ws.send(frame);
    await until(() => s.errors().length > 0);
    expect(s.errors()[0]).toBe("unknown_key");
    expect(await world.rawStore.headSeq("doc")).toBe(0);
  });

  it("rejects edits claimed before the certificate, after it expired, or in the future", async () => {
    const alice = await ids.enroll("alice", { doc: "write" }, { lifetimeMs: 10 * HOUR });
    const r = await start();
    const s = raw(r);
    await authRaw(s, alice);
    await until(() => s.frames.some((f) => f.type === FrameType.AUTH_RESULT));
    const send = (seq: number, claimedAtMs: number) =>
      s.ws.send(signUpdate({ docId: "doc", sessionId: 1, seq, claimedAtMs, payload: new Uint8Array([0]) }, alice.key));
    send(1, T0 - 1);
    send(2, T0 + 10 * HOUR + 1);
    send(3, T0 + 5 * 60_000 + 1);
    await until(() => s.errors().length === 3);
    expect(s.errors()).toEqual(["claimed_before_validity", "claimed_after_expiry", "claimed_in_future"]);
    expect(await world.rawStore.headSeq("doc")).toBe(0);
  });

  it("delivers offline edits made before expiry in upload-only mode, and reads nothing back", async () => {
    const alice = await ids.enroll("alice", { doc: "write" }, { lifetimeMs: 2 * HOUR });
    const bob = await ids.enroll("bob", { doc: "write" }, { lifetimeMs: 200 * HOUR });
    const r = await start();
    const a = await connectAs(r.url, alice, clock, { reconnect: true });
    clients.push(a);
    const b = await connect(r, bob);
    await a.insert(0, "before ");
    await until(() => b.doc.getText() === "before ");

    // Alice goes offline, keeps typing while her certificate is valid, and comes back after it lapsed.
    a.dropConnection();
    const queued = a.insert(7, "written offline");
    clock.advance(2 * HOUR + 30 * 60_000); // 30 minutes past notAfter, inside grace
    await until(() => a.mode === "upload_only" && a.unacked === 0, 5000, "upload-only delivery");
    await queued;
    await until(() => b.doc.getText() === "before written offline");

    // Upload-only means no reading: Bob's later edit never reaches Alice and her SYNC_1 is refused.
    await b.insert(0, ">> ");
    a.sync().catch(() => {});
    await until(() => a.errors.includes("upload_only"), 3000, "SYNC_1 refusal");
    await sleepMs(100);
    expect(a.doc.getText()).toBe("before written offline");
    const stored = await world.rawStore.readUpdates("doc", 0, 10);
    expect(stored).toHaveLength(3);

    // New edits claim a time after expiry, so they are refused even though the connection is allowed.
    await expect(a.insert(0, "late")).rejects.toThrow(/claimed_after_expiry/);
    expect(await world.rawStore.headSeq("doc")).toBe(3);
  });

  it("refuses to connect after the grace window, permanently", async () => {
    const alice = await ids.enroll("alice", { doc: "write" }, { lifetimeMs: HOUR });
    const r = await start();
    clock.advance(HOUR + 72 * HOUR + 1);
    await expect(connectAs(r.url, alice, clock)).rejects.toThrow(/expired/);
  });

  it("drops a revoked certificate on the next check and refuses it afterwards", async () => {
    const alice = await ids.enroll("alice", { doc: "write" });
    const r = await start();
    const s = raw(r);
    await authRaw(s, alice);
    await until(() => s.frames.some((f) => f.type === FrameType.AUTH_RESULT));
    await ids.revoke(alice, "lost_laptop");
    await r.gateway.reauthorize();
    expect(await s.closed()).toEqual({ code: 4401, reason: "revoked" });
    await expect(connectAs(r.url, alice, clock)).rejects.toThrow(/revoked/);
  });

  it("enforces revocation within one poll interval on the real timer", async () => {
    const alice = await ids.enroll("alice", { doc: "write" });
    const r = await start({ revocationPollMs: 40 });
    const s = raw(r);
    await authRaw(s, alice);
    await until(() => s.frames.some((f) => f.type === FrameType.AUTH_RESULT));
    const t0 = Date.now();
    await ids.revoke(alice);
    await s.closed();
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("follows access changes: removing a grant closes the socket, lowering it makes the connection read-only", async () => {
    const alice = await ids.enroll("alice", { doc: "write" });
    const bob = await ids.enroll("bob", { doc: "write" });
    const r = await start();
    const a = await connect(r, alice);
    const sb = raw(r);
    await authRaw(sb, bob);
    await until(() => sb.frames.some((f) => f.type === FrameType.AUTH_RESULT));

    await ids.grant("doc", alice.principal, "read");
    await r.gateway.reauthorize();
    await until(() => a.role === "read", 3000, "role downgrade notice");
    await expect(a.insert(0, "x")).rejects.toThrow(/forbidden/);

    await world.identity.removeGrant("doc", bob.principal.id, { atMs: clock.t, actor: "system", action: "grant.remove", target: "" });
    await r.gateway.reauthorize();
    expect(await sb.closed()).toEqual({ code: 4403, reason: "no_access" });
  });

  it("fails closed when the identity store is down, and keeps serving only for the stale window", async () => {
    const alice = await ids.enroll("alice", { doc: "write" });
    const r = await start({ revocationMaxStaleMs: 60_000 });
    const a = await connect(r, alice);

    world.identity.down = true;
    await expect(connectAs(r.url, alice, clock)).rejects.toThrow(/unavailable/i);
    expect(r.gateway.stats.authFailures["unavailable"]).toBeGreaterThanOrEqual(1);

    clock.advance(30_000);
    await r.gateway.reauthorize();
    await a.insert(0, "still ok"); // within the stale window the last known role holds
    expect(a.connected).toBe(true);

    clock.advance(31_000);
    await r.gateway.reauthorize();
    await until(() => !a.connected, 3000, "close after stale window");

    world.identity.down = false;
    const again = await connect(r, alice);
    await until(() => again.doc.getText() === "still ok");
  });

  it("ignores everything a revoked socket sends while its close handshake is still pending", async () => {
    const alice = await ids.enroll("alice", { doc: "write" });
    const r = await start();
    const s = raw(r);
    await authRaw(s, alice);
    await until(() => s.frames.some((f) => f.type === FrameType.AUTH_RESULT));
    // A hostile client never answers the gateway's close frame, so the socket lingers in CLOSING.
    (s.ws as unknown as { _receiver: { removeAllListeners(e: string): void } })._receiver.removeAllListeners("conclude");
    await ids.revoke(alice);
    await r.gateway.reauthorize();
    const doc = getEngine("yjs").create(1);
    s.ws.send(signUpdate({ docId: "doc", sessionId: 1, seq: 1, claimedAtMs: T0, payload: doc.insertText(0, "after revocation") }, alice.key));
    await sleepMs(150);
    expect(await world.rawStore.headSeq("doc")).toBe(0);
    expect(r.gateway.stats.accepted).toBe(0);
  });

  it("treats a hung identity store as unavailable: refuses newcomers, expires the stale, never overlaps polls", async () => {
    const alice = await ids.enroll("alice", { doc: "write" });
    const r = await start({ identityTimeoutMs: 50, revocationMaxStaleMs: 60_000 });
    const a = await connect(r, alice);
    world.identity.hang = true;

    await expect(connectAs(r.url, alice, clock)).rejects.toThrow(/unavailable/i);

    clock.advance(1000);
    const before = world.identity.authorizeCalls;
    await Promise.all([r.gateway.reauthorize(), r.gateway.reauthorize()]); // the second returns at once
    expect(world.identity.authorizeCalls - before).toBe(1);
    expect(a.connected).toBe(true); // still inside the stale window: last known role holds

    clock.advance(61_000);
    await r.gateway.reauthorize(); // stale connections are closed whether or not the query returns
    await until(() => !a.connected, 3000, "stale connection closed");
  });

  it("applies expiry at the moment of relay, not at the next poll", async () => {
    const alice = await ids.enroll("alice", { doc: "write" });
    const bob = await ids.enroll("bob", { doc: "write" }, { lifetimeMs: HOUR });
    const r = await start();
    const a = await connect(r, alice);
    const b = await connect(r, bob);
    clock.advance(HOUR + 1);
    await a.insert(0, "after bob expired");
    await sleepMs(100);
    expect(b.doc.getText()).toBe("");
    expect(a.doc.getText()).toBe("after bob expired");
  });

  it("rate-limits read-only users too: SYNC_1 floods cost the sender, not the gateway", async () => {
    const rita = await ids.enroll("rita", { doc: "read" });
    const r = await start({ rateLimitPerSecond: 10, rateLimitBurst: 30 });
    const s = raw(r);
    await authRaw(s, rita);
    await until(() => s.frames.some((f) => f.type === FrameType.AUTH_RESULT));
    const sv = getEngine("yjs").create(1).encodeStateVector();
    for (let i = 0; i < 10; i++) s.send({ type: FrameType.SYNC_1, flags: 0, sessionId: 1, seq: 0, payload: sv });
    await until(() => s.errors().some((e) => e.startsWith("rate_limited")));
    expect(s.frames.filter((f) => f.type === FrameType.SYNC_2).length).toBeLessThanOrEqual(3); // 30 tokens / cost 10
  });

  it("does not let a backwards clock step drain the rate limit", async () => {
    const alice = await ids.enroll("alice", { doc: "write" });
    const r = await start({ rateLimitPerSecond: 10, rateLimitBurst: 10 });
    const s = raw(r);
    await authRaw(s, alice);
    await until(() => s.frames.some((f) => f.type === FrameType.AUTH_RESULT));
    const doc = getEngine("yjs").create(1);
    const send = (seq: number) => s.ws.send(signUpdate({ docId: "doc", sessionId: 1, seq, claimedAtMs: T0, payload: doc.insertText(0, "x") }, alice.key));
    send(1);
    send(2);
    await until(() => s.frames.filter((f) => f.type === FrameType.ACK).length === 2);
    clock.advance(-60_000);
    send(3);
    await until(() => s.frames.filter((f) => f.type === FrameType.ACK).length === 3);
    expect(s.errors()).toEqual([]);
  });

  it("closes a connection that sends text before authenticating", async () => {
    const r = await start();
    const s = raw(r);
    await s.nonce();
    s.ws.send("hello");
    expect(await s.closed()).toEqual({ code: 4401, reason: "malformed" });
  });

  it("checks all open connections in one batched identity call", async () => {
    const people = await Promise.all(["a", "b", "c", "d", "e"].map((n) => ids.enroll(n, { doc: "write" })));
    const r = await start();
    for (const p of people) await connect(r, p);
    const before = world.identity.authorizeCalls;
    await r.gateway.reauthorize();
    expect(world.identity.authorizeCalls - before).toBe(1);
  });

  it("rate-limits a flooding connection before it costs a signature verification, then recovers", async () => {
    const alice = await ids.enroll("alice", { doc: "write" });
    const r = await start({ rateLimitPerSecond: 10, rateLimitBurst: 10 });
    const s = raw(r);
    await authRaw(s, alice);
    await until(() => s.frames.some((f) => f.type === FrameType.AUTH_RESULT));
    const doc = getEngine("yjs").create(1);
    const send = (seq: number) => s.ws.send(signUpdate({ docId: "doc", sessionId: 1, seq, claimedAtMs: T0, payload: doc.insertText(0, "x") }, alice.key));
    for (let i = 1; i <= 12; i++) send(i);
    await until(() => s.errors().filter((e) => e.startsWith("rate_limited")).length >= 1);
    const limited = s.errors().filter((e) => e.startsWith("rate_limited"));
    expect(limited[0]).toMatch(/^rate_limited;retry_after_ms=\d+$/);
    expect(r.gateway.stats.rejected["rate_limited"]).toBeGreaterThanOrEqual(1);

    clock.advance(2000); // refill
    const before = s.errors().length;
    send(100);
    await until(() => s.frames.some((f) => f.type === FrameType.ACK && f.seq === 100));
    expect(s.errors().length).toBe(before);
  });

  it("a client retries rate-limited edits until they are stored", async () => {
    const alice = await ids.enroll("alice", { doc: "write" });
    const r = await start({ rateLimitPerSecond: 1000, rateLimitBurst: 12 });
    const a = await connect(r, alice);
    const writes = Array.from({ length: 8 }, (_, i) => a.insert(i, "x"));
    // The frozen test clock never refills the bucket by itself; advance it as time would.
    const ticker = setInterval(() => clock.advance(50), 20);
    try {
      await Promise.all(writes);
    } finally {
      clearInterval(ticker);
    }
    expect(await world.rawStore.headSeq("doc")).toBe(8);
  });
});

describe("gateway configuration", () => {
  it("refuses a rate-limit burst smaller than one SYNC_1", () => {
    const store = new MemoryDocumentStore();
    expect(() => new Gateway({ store, auth: { issuers: [], identity: {} as never, rateLimitBurst: 9 } })).toThrow(/rateLimitBurst/);
  });

  it("requires exactly one way to know who may write", () => {
    const store = new MemoryDocumentStore();
    expect(() => new Gateway({ store })).toThrow(/exactly one/);
    expect(
      () => new Gateway({ store, resolveKey: () => undefined, auth: { issuers: [], identity: {} as never } }),
    ).toThrow(/exactly one/);
  });
});

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
