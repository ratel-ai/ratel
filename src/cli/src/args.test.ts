import { describe, expect, it } from "vitest";
import { ArgError, parseArgs } from "./args.js";

describe("parseArgs — group/verb routing", () => {
  it("with no args returns the help group and no verb", () => {
    const r = parseArgs([]);
    expect(r.group).toBe("help");
    expect(r.verb).toBeUndefined();
  });

  it("treats top-level --help and -h as the help group", () => {
    expect(parseArgs(["--help"]).group).toBe("help");
    expect(parseArgs(["-h"]).group).toBe("help");
  });

  it("treats top-level `help` as the help group", () => {
    expect(parseArgs(["help"]).group).toBe("help");
  });

  it("recognizes the mcp group with no verb", () => {
    const r = parseArgs(["mcp"]);
    expect(r.group).toBe("mcp");
    expect(r.verb).toBeUndefined();
  });

  it("recognizes the backup group with no verb", () => {
    const r = parseArgs(["backup"]);
    expect(r.group).toBe("backup");
    expect(r.verb).toBeUndefined();
  });

  it.each([
    "add",
    "remove",
    "list",
    "get",
    "edit",
    "import",
    "link",
  ] as const)("recognizes mcp %s", (verb) => {
    const r = parseArgs(["mcp", verb]);
    expect(r.group).toBe("mcp");
    expect(r.verb).toBe(verb);
  });

  it("recognizes the top-level serve group", () => {
    const r = parseArgs(["serve"]);
    expect(r.group).toBe("serve");
    expect(r.verb).toBeUndefined();
  });

  it.each(["list", "undo"] as const)("recognizes backup %s", (verb) => {
    const r = parseArgs(["backup", verb]);
    expect(r.group).toBe("backup");
    expect(r.verb).toBe(verb);
  });

  it("rejects an unknown group", () => {
    expect(() => parseArgs(["mcps"])).toThrow(ArgError);
    expect(() => parseArgs(["mcps"])).toThrow(/mcps/);
  });

  it("rejects an unknown verb in a known group", () => {
    expect(() => parseArgs(["mcp", "fly"])).toThrow(ArgError);
    expect(() => parseArgs(["mcp", "fly"])).toThrow(/fly/);
  });

  it("does not treat a path-shaped first arg as an unknown group", () => {
    // we accept this as group=help so the dispatcher can show usage
    // (we no longer infer `run` from a positional file)
    expect(() => parseArgs(["./a.json"])).toThrow(ArgError);
  });

  it("does not consume --help in the middle as a group/verb", () => {
    const r = parseArgs(["serve", "--help"]);
    expect(r.group).toBe("serve");
    expect(r.flags.help).toBe(true);
  });
});

describe("parseArgs — flags and config paths", () => {
  it("collects repeated --config flags in order under serve", () => {
    const r = parseArgs(["serve", "--config", "a.json", "--config", "b.json"]);
    expect(r.configPaths).toEqual(["a.json", "b.json"]);
  });

  it("accepts --config=value long form under serve", () => {
    const r = parseArgs(["serve", "--config=a.json", "--config=b.json"]);
    expect(r.configPaths).toEqual(["a.json", "b.json"]);
  });

  it("treats a positional under serve as a config path", () => {
    const r = parseArgs(["serve", "base.json", "--config", "extra.json"]);
    expect(r.configPaths).toEqual(["base.json", "extra.json"]);
  });

  it("does not treat positionals as config paths under non-serve commands", () => {
    const r = parseArgs(["mcp", "add", "stripe", "https://example.com"]);
    expect(r.configPaths).toEqual([]);
    expect(r.rest).toEqual(["stripe", "https://example.com"]);
  });

  it("throws ArgError when --config has no value", () => {
    expect(() => parseArgs(["serve", "--config"])).toThrow(ArgError);
    expect(() => parseArgs(["serve", "--config", "--other"])).toThrow(ArgError);
    expect(() => parseArgs(["serve", "--config="])).toThrow(ArgError);
  });

  it("collects --key value flag pairs into flags", () => {
    const r = parseArgs(["mcp", "add", "--scope", "user", "--name", "fs"]);
    expect(r.flags).toEqual({ scope: "user", name: "fs" });
  });

  it("treats a bare --key followed by another flag as a boolean", () => {
    const r = parseArgs(["mcp", "import", "--yes", "--dry-run"]);
    expect(r.flags).toEqual({ yes: true, "dry-run": true });
  });

  it("supports --key=value form", () => {
    const r = parseArgs(["mcp", "add", "--scope=user", "--name=fs"]);
    expect(r.flags).toEqual({ scope: "user", name: "fs" });
  });

  it("collects repeated value flags into a string array, preserving order", () => {
    const r = parseArgs([
      "mcp",
      "edit",
      "--scope",
      "user",
      "--name",
      "fs",
      "--arg",
      "a",
      "--arg",
      "b",
    ]);
    expect(r.flags).toMatchObject({ scope: "user", name: "fs", arg: ["a", "b"] });
  });

  it("collects repeated --key=value pairs into a string array", () => {
    const r = parseArgs(["mcp", "edit", "--env=A=1", "--env=B=2", "--env=C=3"]);
    expect(r.flags.env).toEqual(["A=1", "B=2", "C=3"]);
  });

  it("treats --no-foo as flags.foo === false (without consuming the next arg)", () => {
    const r = parseArgs(["mcp", "add", "--no-fetch-description", "name", "--", "cmd"]);
    expect(r.flags["fetch-description"]).toBe(false);
    expect(r.rest).toEqual(["name"]);
    expect(r.extras).toEqual(["cmd"]);
  });

  it("--no-X overrides a prior --X (last write wins)", () => {
    const r = parseArgs(["mcp", "add", "--fetch-description", "--no-fetch-description", "name"]);
    expect(r.flags["fetch-description"]).toBe(false);
  });

  it("recognises -e as a short alias for --env", () => {
    const r = parseArgs(["mcp", "add", "-e", "A=1", "-e", "B=2", "stripe"]);
    expect(r.flags.env).toEqual(["A=1", "B=2"]);
    expect(r.rest).toEqual(["stripe"]);
  });
});

describe("parseArgs — `--` handling for `mcp add`", () => {
  it("routes tokens before `--` to rest, tokens after to extras", () => {
    const r = parseArgs(["mcp", "add", "--scope", "user", "stripe", "--", "npx", "-y", "@x/y"]);
    expect(r.flags).toEqual({ scope: "user" });
    expect(r.rest).toEqual(["stripe"]);
    expect(r.extras).toEqual(["npx", "-y", "@x/y"]);
  });

  it("leaves extras empty when there is no `--`", () => {
    const r = parseArgs(["mcp", "add", "stripe", "https://example.com"]);
    expect(r.extras).toEqual([]);
  });

  it("treats flags after `--` as plain tokens (no parsing)", () => {
    const r = parseArgs(["mcp", "add", "stripe", "--", "cmd", "--flag-of-cmd", "x"]);
    expect(r.extras).toEqual(["cmd", "--flag-of-cmd", "x"]);
    expect(r.flags["flag-of-cmd"]).toBeUndefined();
  });
});
