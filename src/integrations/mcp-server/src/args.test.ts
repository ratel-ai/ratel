import { describe, expect, it } from "vitest";
import { ArgError, parseArgs } from "./args.js";

describe("parseArgs", () => {
  it("treats a bare positional as run with one config path", () => {
    const r = parseArgs(["config.json"]);
    expect(r.subcommand).toBe("run");
    expect(r.configPaths).toEqual(["config.json"]);
    expect(r.rest).toEqual([]);
    expect(r.flags).toEqual({});
  });

  it("returns subcommand=run with empty fields for empty argv", () => {
    const r = parseArgs([]);
    expect(r).toEqual({ subcommand: "run", configPaths: [], rest: [], flags: {} });
  });

  it("collects repeated --config flags in order", () => {
    const r = parseArgs(["--config", "a.json", "--config", "b.json"]);
    expect(r.subcommand).toBe("run");
    expect(r.configPaths).toEqual(["a.json", "b.json"]);
  });

  it("accepts --config=value long form", () => {
    const r = parseArgs(["--config=a.json", "--config=b.json"]);
    expect(r.configPaths).toEqual(["a.json", "b.json"]);
  });

  it("treats positional and --config as both contributing to configPaths in order", () => {
    const r = parseArgs(["base.json", "--config", "extra.json"]);
    expect(r.configPaths).toEqual(["base.json", "extra.json"]);
  });

  it.each([
    "import",
    "add",
    "remove",
    "list",
    "undo",
    "run",
  ] as const)("recognizes %s as a subcommand and consumes it", (sub) => {
    const r = parseArgs([sub]);
    expect(r.subcommand).toBe(sub);
  });

  it("routes --help to the help subcommand", () => {
    expect(parseArgs(["--help"]).subcommand).toBe("help");
  });

  it("routes -h to the help subcommand", () => {
    expect(parseArgs(["-h"]).subcommand).toBe("help");
  });

  it("throws ArgError for an unknown subcommand, naming the offender", () => {
    expect(() => parseArgs(["importt"])).toThrow(ArgError);
    expect(() => parseArgs(["importt"])).toThrow(/importt/);
  });

  it("does not treat a path-shaped first arg as an unknown subcommand", () => {
    expect(parseArgs(["./a.json"]).configPaths).toEqual(["./a.json"]);
    expect(parseArgs(["/abs/a.json"]).configPaths).toEqual(["/abs/a.json"]);
    expect(parseArgs(["a.json"]).configPaths).toEqual(["a.json"]);
  });

  it("throws ArgError when --config has no value", () => {
    expect(() => parseArgs(["--config"])).toThrow(ArgError);
    expect(() => parseArgs(["--config", "--other"])).toThrow(ArgError);
    expect(() => parseArgs(["--config="])).toThrow(ArgError);
  });

  it("collects --key value flag pairs into flags", () => {
    const r = parseArgs(["add", "--scope", "global", "--name", "fs"]);
    expect(r.subcommand).toBe("add");
    expect(r.flags).toEqual({ scope: "global", name: "fs" });
  });

  it("treats a bare --key followed by another flag as a boolean", () => {
    const r = parseArgs(["import", "--yes", "--dry-run"]);
    expect(r.flags).toEqual({ yes: true, "dry-run": true });
  });

  it("supports --key=value form for non-config flags", () => {
    const r = parseArgs(["add", "--scope=global", "--name=fs"]);
    expect(r.flags).toEqual({ scope: "global", name: "fs" });
  });

  it("stops flag parsing after --", () => {
    const r = parseArgs(["add", "--name", "fs", "--", "--not-a-flag", "arg"]);
    expect(r.flags).toEqual({ name: "fs" });
    expect(r.rest).toEqual(["--not-a-flag", "arg"]);
  });

  it("collects repeated value flags into a string array, preserving order", () => {
    const r = parseArgs(["edit", "--scope", "global", "--name", "fs", "--arg", "a", "--arg", "b"]);
    expect(r.flags).toMatchObject({ scope: "global", name: "fs", arg: ["a", "b"] });
  });

  it("collects repeated --key=value pairs into a string array", () => {
    const r = parseArgs(["edit", "--env=A=1", "--env=B=2", "--env=C=3"]);
    expect(r.flags.env).toEqual(["A=1", "B=2", "C=3"]);
  });

  it("routes positionals after a non-run subcommand into rest", () => {
    const r = parseArgs(["add", "fs", "extra"]);
    expect(r.rest).toEqual(["fs", "extra"]);
    expect(r.configPaths).toEqual([]);
  });
});
