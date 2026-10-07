import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/app/config.js";
import { RENEW_BEFORE_MS, reusableCertificate, storedCert } from "../src/app/cert-cache.js";
import { Recent, type StorageLike } from "../src/app/recent.js";

const memory = (): StorageLike & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};
const A = "0b6f0f0e-7d2c-4c5e-9b0a-1f2e3d4c5b6a";
const B = "1b6f0f0e-7d2c-4c5e-9b0a-1f2e3d4c5b6a";

describe("recent workbooks", () => {
  it("remembers newest first, replaces by id, and forgets", () => {
    const r = new Recent(memory());
    expect(r.list()).toEqual([]);
    r.remember(A, "One");
    r.remember(B, "Two");
    r.remember(A, "One, renamed");
    expect(r.list()).toEqual([{ id: A, title: "One, renamed" }, { id: B, title: "Two" }]);
    r.forget(A);
    expect(r.list()).toEqual([{ id: B, title: "Two" }]);
  });
  it("keeps at most 20, and cuts long titles", () => {
    const r = new Recent(memory());
    for (let i = 0; i < 25; i++) r.remember(`${String(i).padStart(8, "0")}-7d2c-4c5e-9b0a-1f2e3d4c5b6a`, `t${i}`);
    expect(r.list()).toHaveLength(20);
    expect(r.list()[0]?.title).toBe("t24");
    const written = memory();
    new Recent(written).remember(A, "x".repeat(500));
    expect((JSON.parse(written.data.get("omnisync-reference-recent") as string) as { title: string }[])[0]?.title).toHaveLength(100); // cut when written, not only when read
    r.remember(A, "x".repeat(500));
    expect(r.list()[0]?.title).toHaveLength(100);
  });
  it("ignores ids that are not document ids, and survives broken or missing storage", () => {
    const m = memory();
    const r = new Recent(m);
    r.remember("not-a-uuid", "x");
    r.remember("../../etc", "x");
    expect(r.list()).toEqual([]);
    m.data.set("omnisync-reference-recent", "{not json");
    expect(r.list()).toEqual([]);
    m.data.set("omnisync-reference-recent", JSON.stringify([{ id: A, title: "ok" }, { id: "bad", title: "x" }, { id: B }, null, 5, { id: B, title: 5 }]));
    expect(r.list()).toEqual([{ id: A, title: "ok" }]);
    m.data.set("omnisync-reference-recent", JSON.stringify({ not: "an array" }));
    expect(r.list()).toEqual([]);
    m.data.set("omnisync-reference-recent", JSON.stringify([{ id: A, title: "y".repeat(500) }]));
    expect(r.list()[0]?.title).toHaveLength(100);
    r.remember("1b6f0f0e-7d2c-1c5e-9b0a-1f2e3d4c5b6a", "not version 4");
    m.data.set("omnisync-reference-recent", JSON.stringify([{ id: "1b6f0f0e-7d2c-1c5e-9b0a-1f2e3d4c5b6a", title: "x" }]));
    expect(r.list()).toEqual([]);
    const none = new Recent(undefined);
    none.remember(A, "x");
    expect(none.list()).toEqual([]);
    const full = new Recent({ getItem: () => null, setItem: () => { throw new Error("quota"); } });
    expect(() => full.remember(A, "x")).not.toThrow();
    expect(() => full.forget(A)).not.toThrow();
  });
});

describe("config", () => {
  it("accepts origins and trims trailing slashes", () => {
    expect(parseConfig({ controlPlane: "https://cp.example.com/", gateway: "wss://sync.example.com/" })).toEqual({ controlPlane: "https://cp.example.com", gateway: "wss://sync.example.com" });
    expect(parseConfig({ controlPlane: "", gateway: "ws://localhost:8080" })).toEqual({ controlPlane: "", gateway: "ws://localhost:8080" });
  });
  it("rejects anything else", () => {
    const ok = { controlPlane: "https://cp.example.com", gateway: "wss://sync.example.com" };
    for (const bad of [undefined, null, {}, { controlPlane: "https://cp.example.com" }, { gateway: "wss://x" }, { ...ok, gateway: "https://sync.example.com" }, { ...ok, gateway: "wss://sync.example.com/path" }, { ...ok, gateway: "wss://u:p@sync.example.com" }, { ...ok, controlPlane: "wss://cp.example.com" }, { ...ok, controlPlane: "https://cp.example.com/x" }, { ...ok, controlPlane: "javascript:1" }, { ...ok, controlPlane: 5 }]) {
      expect(() => parseConfig(bad), JSON.stringify(bad)).toThrow();
    }
    expect(() => parseConfig({ gateway: "wss://x" })).toThrow(/needs controlPlane and gateway/);
    expect(() => parseConfig({ ...ok, gateway: "wss://sync.example.com:123456" })).toThrow(/WebSocket origin/);
    expect(() => parseConfig({ ...ok, controlPlane: "https://cp.example.com:1234567" })).toThrow(/origin/);
  });
});

describe("certificate cache", () => {
  const now = 1_000_000_000;
  const stored = (over: object = {}) => JSON.stringify({ publicKey: "ab".repeat(32), certificate: "Y2VydA", notAfterMs: now + 3_600_000, ...over });
  it("reuses a certificate of this key with more than 15 minutes left", () => {
    expect(reusableCertificate(stored(), "ab".repeat(32), now)).toBe("Y2VydA");
    expect(reusableCertificate(stored({ notAfterMs: now + RENEW_BEFORE_MS + 1 }), "ab".repeat(32), now)).toBe("Y2VydA");
  });
  it("renews in the last 15 minutes exactly (the window is part of the contract)", () => {
    expect(reusableCertificate(stored({ notAfterMs: now + 14 * 60_000 }), "ab".repeat(32), now)).toBeUndefined();
    expect(reusableCertificate(stored({ notAfterMs: now + 16 * 60_000 }), "ab".repeat(32), now)).toBe("Y2VydA");
  });
  it("replaces one that is about to lapse, has lapsed, or belongs to another key", () => {
    expect(reusableCertificate(stored({ notAfterMs: now + RENEW_BEFORE_MS }), "ab".repeat(32), now)).toBeUndefined();
    expect(reusableCertificate(stored({ notAfterMs: now - 1 }), "ab".repeat(32), now)).toBeUndefined();
    expect(reusableCertificate(stored(), "cd".repeat(32), now)).toBeUndefined();
  });
  it("treats missing or damaged storage as nothing stored", () => {
    for (const raw of [null, "", "{not json", "null", "5", "[]", stored({ certificate: 5 }), stored({ publicKey: undefined }), stored({ notAfterMs: "soon" })]) {
      expect(reusableCertificate(raw, "ab".repeat(32), now), String(raw)).toBeUndefined();
    }
  });
  it("round-trips what it stores", () => {
    expect(reusableCertificate(storedCert("ab".repeat(32), "Q0VSVA", now + 3_600_000), "ab".repeat(32), now)).toBe("Q0VSVA");
  });
});
