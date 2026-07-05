import { describe, expect, it } from "vitest";
import { locateRatelBin } from "./locate-bin.js";

describe("locateRatelBin", () => {
  it("prefers $RATEL_BIN when set", async () => {
    const r = await locateRatelBin({ envVar: "/custom/bin" });
    expect(r).toEqual({ command: "/custom/bin", args: [], source: "env" });
  });

  it("treats an empty env var as unset", async () => {
    const r = await locateRatelBin({
      envVar: "",
      whichResult: "/usr/local/bin/ratel",
    });
    expect(r.source).toBe("path");
  });

  it("falls back to PATH lookup when env var unset", async () => {
    const r = await locateRatelBin({ whichResult: "/usr/local/bin/ratel" });
    expect(r).toEqual({
      command: "/usr/local/bin/ratel",
      args: [],
      source: "path",
    });
  });

  it("falls back to workspace src/cli/dist/bin.js with `node` as command", async () => {
    const r = await locateRatelBin({
      workspaceRoot: "/repo",
      exists: async (p) => p === "/repo/src/cli/dist/bin.js",
    });
    expect(r).toEqual({
      command: "node",
      args: ["/repo/src/cli/dist/bin.js"],
      source: "workspace",
    });
  });

  it("skips the workspace branch when dist/bin.js is missing", async () => {
    let prompted = false;
    const r = await locateRatelBin({
      workspaceRoot: "/repo",
      exists: async () => false,
      promptForPath: async () => {
        prompted = true;
        return "/from/prompt/bin";
      },
    });
    expect(prompted).toBe(true);
    expect(r.source).toBe("prompt");
  });

  it("prompts when nothing else resolves and uses the prompted path", async () => {
    const r = await locateRatelBin({
      promptForPath: async () => "/asked/for/this",
    });
    expect(r).toEqual({ command: "/asked/for/this", args: [], source: "prompt" });
  });

  it("resolves a relative prompted path to absolute", async () => {
    const r = await locateRatelBin({
      promptForPath: async () => "relative/bin",
    });
    expect(r.command.startsWith("/")).toBe(true);
    expect(r.command.endsWith("relative/bin")).toBe(true);
  });

  it("throws when prompt returns empty and no other branch matched", async () => {
    await expect(locateRatelBin({ promptForPath: async () => "" })).rejects.toThrow();
  });

  it("throws when nothing is configured", async () => {
    await expect(locateRatelBin({})).rejects.toThrow();
  });
});
