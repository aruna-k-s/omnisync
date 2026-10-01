import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { engines } from "@omnisync/engine";
import { FrameType, Keyring, encodeFrame, generateKeyPair, signUpdate } from "@omnisync/protocol";
import { Gateway, GatewayClient } from "../src/index.js";

const alice = generateKeyPair(new Uint8Array(32).fill(1));
const bob = generateKeyPair(new Uint8Array(32).fill(2));
const mallory = generateKeyPair(new Uint8Array(32).fill(3));

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
};

for (const engine of Object.keys(engines) as (keyof typeof engines)[]) {
  describe(`gateway with ${engine}`, () => {
    let gateway: Gateway;
    let url: string;
    const clients: GatewayClient[] = [];
    const connect = async (actor: number, key = actor === 1 ? alice : bob, docId = "doc-1") => {
      const c = await GatewayClient.connect({ url, docId, actor, key, engine });
      clients.push(c);
      return c;
    };

    beforeEach(async () => {
      const ring = new Keyring();
      ring.add(alice.publicKey);
      ring.add(bob.publicKey);
      gateway = new Gateway({ engine, resolveKey: ring.resolve });
      url = `ws://127.0.0.1:${await gateway.listen()}`;
    });

    afterEach(async () => {
      await Promise.all(clients.splice(0).map((c) => c.close()));
      await gateway.close();
    });

    it("relays signed edits between two clients and converges", async () => {
      const a = await connect(1);
      const b = await connect(2);
      await a.insert(0, "hello");
      await until(() => b.doc.getText() === "hello");
      await Promise.all([a.insert(5, " world"), b.insert(0, ">> ")]);
      await until(() => a.doc.getText() === b.doc.getText() && a.doc.getText().length === 14);
      expect(gateway.textOf("doc-1")).toBe(a.doc.getText());
      expect(gateway.stats.accepted).toBe(3);
    });

    it("late joiner catches up through SYNC_1/SYNC_2", async () => {
      const a = await connect(1);
      await a.insert(0, "before you arrived");
      const b = await connect(2);
      expect(b.doc.getText()).toBe("before you arrived");
    });

    it("isolates documents", async () => {
      const a = await connect(1, alice, "doc-a");
      const b = await connect(2, bob, "doc-b");
      await a.insert(0, "only in a");
      await new Promise((r) => setTimeout(r, 30));
      expect(b.doc.getText()).toBe("");
    });

    it("rejects updates from unknown keys and never applies them", async () => {
      const a = await connect(1);
      const forged = signUpdate({ docId: "doc-1", sessionId: 1, seq: 1, payload: a.doc.insertText(0, "evil") }, mallory);
      a.sendRaw(forged);
      await until(() => a.errors.includes("unknown_key"));
      expect(gateway.textOf("doc-1")).toBe("");
    });

    it("rejects an update signed for another document", async () => {
      const a = await connect(1);
      const wrongDoc = signUpdate({ docId: "doc-2", sessionId: 1, seq: 1, payload: a.doc.insertText(0, "x") }, alice);
      a.sendRaw(wrongDoc);
      await until(() => a.errors.includes("bad_signature"));
      expect(gateway.textOf("doc-1")).toBe("");
    });

    it("acknowledges an exact retry once without applying it twice", async () => {
      const a = await connect(1);
      const frame = signUpdate({ docId: "doc-1", sessionId: 9, seq: 1, payload: a.doc.insertText(0, "once") }, alice);
      a.sendRaw(frame);
      a.sendRaw(frame);
      await until(() => gateway.stats.duplicates === 1);
      expect(gateway.stats.accepted).toBe(1);
      expect(gateway.textOf("doc-1")).toBe("once");
      expect(a.errors).toEqual([]);
    });

    it("rejects an old client seq that was never stored", async () => {
      const a = await connect(1);
      a.sendRaw(signUpdate({ docId: "doc-1", sessionId: 9, seq: 5, payload: a.doc.insertText(0, "x") }, alice));
      a.sendRaw(signUpdate({ docId: "doc-1", sessionId: 9, seq: 3, payload: a.doc.insertText(0, "y") }, alice));
      await until(() => a.errors.includes("replay"));
      expect(gateway.stats.accepted).toBe(1);
    });

    it("refuses client SYNC_2 so unsigned state can never enter", async () => {
      const a = await connect(1);
      a.sendRaw(encodeFrame({ type: FrameType.SYNC_2, flags: 0, sessionId: 0, seq: 0, payload: new Uint8Array([1, 2]) }));
      a.sendRaw(new Uint8Array([0xde, 0xad]));
      await until(() => a.errors.includes("type_not_allowed") && a.errors.includes("malformed"));
    });
  });
}
