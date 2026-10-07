import { describe, expect, it } from "vitest";
import { deviceCodeFromSearch, removeDeviceParam } from "../src/app/device-code.js";

describe("device code in the address", () => {
  it("reads a user code from ?device=, in either case, with or without the hyphen, and normalises it", () => {
    expect(deviceCodeFromSearch("?device=BCDF-GHJK")).toBe("BCDF-GHJK");
    expect(deviceCodeFromSearch("?device=bcdf-ghjk")).toBe("BCDF-GHJK");
    expect(deviceCodeFromSearch("?device=bcdfghjk")).toBe("BCDF-GHJK");
    expect(deviceCodeFromSearch("?x=1&device=BCDFGHJK&y=2")).toBe("BCDF-GHJK");
  });
  it("ignores anything that is not a user code", () => {
    for (const s of ["", "?", "?device=", "?device=ABC", "?device=AEIOUAEI", "?device=BCDF-GHJK-X", "?device=BCDF--GHJK", "?device=<script>", "?device=BCDF%20GHJK", "?device=BCDF-GHJK&device=BCDF-GHJL", "?other=BCDF-GHJK", "?device[]=BCDF-GHJK"]) {
      expect(deviceCodeFromSearch(s), s).toBeUndefined();
    }
  });
  it("removes only the device parameter from the query", () => {
    expect(removeDeviceParam("?device=BCDF-GHJK")).toBe("");
    expect(removeDeviceParam("?a=1&device=BCDF-GHJK&b=2")).toBe("?a=1&b=2");
    expect(removeDeviceParam("?a=1")).toBe("?a=1");
    expect(removeDeviceParam("")).toBe("");
  });
});
