import { describe, expect, it } from "vitest";
import { certState, shortId, when } from "../src/app/format.js";

describe("format", () => {
  it("prints UTC to the second", () => {
    expect(when(0)).toBe("1970-01-01 00:00:00Z");
    expect(when(1_800_000_000_999)).toBe("2027-01-15 08:00:00Z");
  });
  it("shortens long ids and leaves short ones", () => {
    expect(shortId("0b6f0f0e-7d2c-4c5e-9b0a-1f2e3d4c5b6a")).toBe("0b6f0f0e…5b6a");
    expect(shortId("p_abcdef12345")).toBe("p_abcdef12345");
    expect(shortId("p_abcdef123456")).toBe("p_abcdef…3456");
  });
  it("derives a certificate's state, revocation first", () => {
    const c = { notBeforeMs: 100, notAfterMs: 200 };
    expect(certState(c, 150)).toBe("active");
    expect(certState(c, 99)).toBe("not yet valid");
    expect(certState(c, 100)).toBe("active");
    expect(certState(c, 199)).toBe("active");
    expect(certState(c, 200)).toBe("expired");
    expect(certState({ ...c, revokedAtMs: 120 }, 150)).toBe("revoked");
    expect(certState({ ...c, revokedAtMs: 120 }, 500)).toBe("revoked");
  });
});
