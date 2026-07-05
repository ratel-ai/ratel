import { describe, expect, it } from "vitest";
import { claudeConfigPath, readClaudeConfig } from "./claude.js";
import { ProjectRootNotFoundError } from "./hierarchy.js";

const HOME = "/home/u";
const ROOT = "/r";

function fakeFs(files: Record<string, string>) {
  return {
    read: async (p: string) => (Object.hasOwn(files, p) ? files[p] : null),
  };
}

describe("claudeConfigPath", () => {
  it("resolves global to <home>/.claude.json", () => {
    expect(claudeConfigPath("user", { homeDir: HOME })).toBe("/home/u/.claude.json");
  });

  it("resolves project to <root>/.mcp.json", () => {
    expect(claudeConfigPath("project", { homeDir: HOME, projectRoot: ROOT })).toBe("/r/.mcp.json");
  });

  it("resolves local to the same file as global (~/.claude.json)", () => {
    expect(claudeConfigPath("local", { homeDir: HOME, projectRoot: ROOT })).toBe(
      "/home/u/.claude.json",
    );
  });

  it("throws when project is requested without a project root", () => {
    expect(() => claudeConfigPath("project", { homeDir: HOME })).toThrow(ProjectRootNotFoundError);
  });
});

describe("readClaudeConfig", () => {
  it("returns null when the file is missing", async () => {
    const doc = await readClaudeConfig("user", { homeDir: HOME }, fakeFs({}));
    expect(doc).toBeNull();
  });

  it("returns an empty mcpServers when the global file has no key", async () => {
    const fs = fakeFs({ "/home/u/.claude.json": JSON.stringify({ otherStuff: 1 }) });
    const doc = await readClaudeConfig("user", { homeDir: HOME }, fs);
    expect(doc?.mcpServers).toEqual({});
    expect(doc?.raw).toEqual({ otherStuff: 1 });
    expect(doc?.scope).toBe("user");
    expect(doc?.path).toBe("/home/u/.claude.json");
  });

  it("reads mcpServers from the root for the global scope", async () => {
    const fs = fakeFs({
      "/home/u/.claude.json": JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    });
    const doc = await readClaudeConfig("user", { homeDir: HOME }, fs);
    expect(doc?.mcpServers).toEqual({ fs: { type: "stdio", command: "echo" } });
  });

  it("reads mcpServers from <root>/.mcp.json for the project scope", async () => {
    const fs = fakeFs({
      "/r/.mcp.json": JSON.stringify({
        mcpServers: { proj: { type: "stdio", command: "echo" } },
      }),
    });
    const doc = await readClaudeConfig("project", { homeDir: HOME, projectRoot: ROOT }, fs);
    expect(doc?.mcpServers).toEqual({ proj: { type: "stdio", command: "echo" } });
    expect(doc?.path).toBe("/r/.mcp.json");
  });

  it("reads mcpServers from projects[<absolute_root>] for the local scope", async () => {
    const fs = fakeFs({
      "/home/u/.claude.json": JSON.stringify({
        projects: {
          "/r": { mcpServers: { local: { type: "stdio", command: "echo" } } },
          "/elsewhere": { mcpServers: { other: { type: "stdio", command: "x" } } },
        },
      }),
    });
    const doc = await readClaudeConfig("local", { homeDir: HOME, projectRoot: ROOT }, fs);
    expect(doc?.mcpServers).toEqual({ local: { type: "stdio", command: "echo" } });
  });

  it("returns empty mcpServers when projects key is missing for local scope", async () => {
    const fs = fakeFs({
      "/home/u/.claude.json": JSON.stringify({ mcpServers: { fs: { command: "x" } } }),
    });
    const doc = await readClaudeConfig("local", { homeDir: HOME, projectRoot: ROOT }, fs);
    expect(doc?.mcpServers).toEqual({});
  });

  it("returns empty mcpServers when projects[<root>] has no mcpServers field", async () => {
    const fs = fakeFs({
      "/home/u/.claude.json": JSON.stringify({
        projects: { "/r": { somethingElse: true } },
      }),
    });
    const doc = await readClaudeConfig("local", { homeDir: HOME, projectRoot: ROOT }, fs);
    expect(doc?.mcpServers).toEqual({});
  });

  it("preserves the full raw document so non-mcp keys survive a future write", async () => {
    const raw = {
      version: 7,
      otherSetting: { nested: true },
      mcpServers: { fs: { command: "echo" } },
      projects: { "/elsewhere": { mcpServers: { other: { command: "x" } } } },
    };
    const fs = fakeFs({ "/home/u/.claude.json": JSON.stringify(raw) });
    const doc = await readClaudeConfig("user", { homeDir: HOME }, fs);
    expect(doc?.raw).toEqual(raw);
  });

  it("throws when local scope is requested without a project root", async () => {
    await expect(readClaudeConfig("local", { homeDir: HOME }, fakeFs({}))).rejects.toThrow(
      ProjectRootNotFoundError,
    );
  });

  it("surfaces a parse error when the file is not valid JSON", async () => {
    const fs = fakeFs({ "/home/u/.claude.json": "not json" });
    await expect(readClaudeConfig("user", { homeDir: HOME }, fs)).rejects.toThrow(
      /\/home\/u\/\.claude\.json/,
    );
  });

  it("passes non-Ratel-shaped entries through verbatim (no validation)", async () => {
    const fs = fakeFs({
      "/home/u/.claude.json": JSON.stringify({
        mcpServers: {
          weird: { type: "stdio" /* missing command */ },
          alsoWeird: { type: "fake", custom: true },
        },
      }),
    });
    const doc = await readClaudeConfig("user", { homeDir: HOME }, fs);
    expect(doc?.mcpServers.weird).toEqual({ type: "stdio" });
    expect(doc?.mcpServers.alsoWeird).toEqual({ type: "fake", custom: true });
  });
});
