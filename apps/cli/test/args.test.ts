import { describe, expect, it } from "vitest";
import { UsageError, parseArgs } from "../src/args.js";

describe("command line", () => {
  it("parses the three commands", () => {
    expect(parseArgs(["login", "--server", "https://cp.example.com"], {})).toEqual({ command: "login", server: "https://cp.example.com" });
    expect(parseArgs(["whoami"], {})).toEqual({ command: "whoami" });
    expect(parseArgs(["logout"], {})).toEqual({ command: "logout" });
  });
  it("takes all login options in both spellings, and the server from the environment", () => {
    expect(parseArgs(["login", "--server=https://a.example", "--gateway=wss://g.example", "--label", "ci box"], {})).toEqual({ command: "login", server: "https://a.example", gateway: "wss://g.example", label: "ci box" });
    expect(parseArgs(["login"], { OMNISYNC_SERVER: "https://env.example" })).toEqual({ command: "login", server: "https://env.example" });
    expect(parseArgs(["login", "--server", "https://flag.example"], { OMNISYNC_SERVER: "https://env.example" })).toEqual({ command: "login", server: "https://flag.example" });
    expect(parseArgs(["login", "--server", "https://a.example"], { OMNISYNC_GATEWAY: "wss://env-gw.example" })).toEqual({ command: "login", server: "https://a.example", gateway: "wss://env-gw.example" });
  });
  it("asks for help", () => {
    for (const a of [[], ["--help"], ["-h"], ["help"]]) expect(parseArgs(a, {})).toEqual({ command: "help" });
  });
  it("refuses everything else, naming the problem", () => {
    const bad: [string[], RegExp][] = [
      [["frobnicate"], /unknown command/],
      [["login"], /--server/],
      [["login", "--server"], /needs a value/],
      [["login", "--server", "--label", "x"], /needs a value/],
      [["login", "--server", "a", "--server", "b"], /more than once/],
      [["login", "--server", "https://a.example", "--bogus", "1"], /unknown option/],
      [["login", "--server", "https://a.example", "extra"], /unexpected argument/],
      [["whoami", "--server", "https://a.example"], /unknown option/],
      [["logout", "now"], /unexpected argument/],
      [["login", "--server=https://a.example", "--label="], /needs a value/],
    ];
    for (const [argv, why] of bad) {
      expect(() => parseArgs(argv, {}), argv.join(" ")).toThrow(UsageError);
      expect(() => parseArgs(argv, {}), argv.join(" ")).toThrow(why);
    }
  });
});
