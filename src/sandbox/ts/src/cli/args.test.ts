import { describe, expect, it } from "vitest";
import { CliError, parseArgs, USAGE } from "./args.js";

describe("parseArgs: dev", () => {
  it("parses `ratel sandbox dev` with and without --url", () => {
    expect(parseArgs(["sandbox", "dev"])).toEqual({ command: "dev" });
    expect(parseArgs(["sandbox", "dev", "--url", "http://x"])).toEqual({
      command: "dev",
      url: "http://x",
    });
  });

  it("keeps `ratel dev` as a deprecated alias of `ratel sandbox dev`", () => {
    expect(parseArgs(["dev"])).toEqual({ command: "dev", deprecatedAlias: true });
    expect(parseArgs(["dev", "--url", "http://x"])).toEqual({
      command: "dev",
      url: "http://x",
      deprecatedAlias: true,
    });
  });

  it("lists only `ratel sandbox dev` in the usage", () => {
    expect(USAGE).toContain("ratel sandbox dev");
    expect(USAGE).not.toMatch(/ratel dev/);
  });

  it("rejects an unknown option of sandbox dev", () => {
    expect(() => parseArgs(["sandbox", "dev", "--nope"])).toThrow(CliError);
  });
});

describe("parseArgs: run --dry", () => {
  it("sets dry only when --dry is given", () => {
    expect(parseArgs(["sandbox", "run", "a", "--input", "in.json", "--dry"])).toMatchObject({
      command: "run",
      dry: true,
    });
    expect(parseArgs(["sandbox", "run", "a", "--input", "in.json"])).not.toHaveProperty("dry");
    expect(USAGE).toMatch(/sandbox run <id>[^\n]*\n[^\n]*\[--dry\]/);
  });
});
