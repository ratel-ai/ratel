import { describe, expect, it } from "vitest";
import type { ParsedArgs } from "../args.js";
import type { BackupFs } from "../backup.js";
import type { ClaudeFs } from "../claude.js";
import type { HierarchyEnv } from "../hierarchy.js";
import type { JsonFs } from "../io.js";
import { silentPromptAdapter } from "../prompts.js";
import { runRemove } from "./remove.js";
import type { HandlerCtx } from "./types.js";

const HOME = "/home/u";
const ROOT = "/r";

class MemFs implements BackupFs, JsonFs, ClaudeFs {
  files = new Map<string, string>();
  async read(p: string) {
    return this.files.has(p) ? (this.files.get(p) as string) : null;
  }
  async write(p: string, c: string) {
    this.files.set(p, c);
  }
  async writeAtomic(p: string, c: string) {
    this.files.set(p, c);
  }
  async remove(p: string) {
    this.files.delete(p);
  }
  async mkdirp() {}
  async exists(p: string) {
    return this.files.has(p);
  }
  async list(p: string) {
    const prefix = p.endsWith("/") ? p : `${p}/`;
    const names = new Set<string>();
    for (const f of this.files.keys()) {
      if (f.startsWith(prefix)) {
        const rest = f.slice(prefix.length);
        const slash = rest.indexOf("/");
        names.add(slash >= 0 ? rest.slice(0, slash) : rest);
      }
    }
    return Array.from(names);
  }
}

function makeCtx(fs: MemFs, args: { flags: ParsedArgs["flags"]; env?: HierarchyEnv }): HandlerCtx {
  return {
    argv: {
      group: "mcp",
      verb: "remove",
      configPaths: [],
      rest: [],
      extras: [],
      flags: args.flags,
    },
    env: args.env ?? { homeDir: HOME, projectRoot: ROOT },
    fs,
    log: () => {},
    prompts: silentPromptAdapter(),
  };
}

describe("runRemove", () => {
  it("removes an entry from the requested Ratel scope and leaves siblings intact", async () => {
    const fs = new MemFs();
    fs.files.set(
      "/home/u/.ratel/config.json",
      `${JSON.stringify({
        mcpServers: {
          fs: { type: "stdio", command: "echo" },
          other: { type: "stdio", command: "ls" },
        },
      })}\n`,
    );
    const ctx = makeCtx(fs, { flags: { scope: "user", name: "fs" } });
    await runRemove(ctx);
    const parsed = JSON.parse(fs.files.get("/home/u/.ratel/config.json") as string);
    expect(parsed.mcpServers.fs).toBeUndefined();
    expect(parsed.mcpServers.other).toBeDefined();
  });

  it("errors when the entry doesn't exist", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, { flags: { scope: "user", name: "missing" } });
    await expect(runRemove(ctx)).rejects.toThrow(/missing/);
  });

  it("leaves the file with empty mcpServers when the last entry is removed (no file delete)", async () => {
    const fs = new MemFs();
    fs.files.set(
      "/home/u/.ratel/config.json",
      `${JSON.stringify({
        mcpServers: { only: { type: "stdio", command: "x" } },
      })}\n`,
    );
    const ctx = makeCtx(fs, { flags: { scope: "user", name: "only" } });
    await runRemove(ctx);
    expect(fs.files.has("/home/u/.ratel/config.json")).toBe(true);
    const parsed = JSON.parse(fs.files.get("/home/u/.ratel/config.json") as string);
    expect(parsed).toEqual({ mcpServers: {} });
  });

  it("captures a backup before writing", async () => {
    const fs = new MemFs();
    fs.files.set(
      "/home/u/.ratel/config.json",
      `${JSON.stringify({
        mcpServers: { x: { type: "stdio", command: "x" } },
      })}\n`,
    );
    const ctx = makeCtx(fs, { flags: { scope: "user", name: "x" } });
    await runRemove(ctx);
    const backupKeys = Array.from(fs.files.keys()).filter((k) =>
      k.startsWith("/home/u/.ratel/backups/"),
    );
    expect(backupKeys.length).toBeGreaterThan(0);
  });

  it("errors when project scope requested without a project root", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "project", name: "fs" },
      env: { homeDir: HOME },
    });
    await expect(runRemove(ctx)).rejects.toThrow();
  });

  it("defaults to user scope when --scope is omitted", async () => {
    const fs = new MemFs();
    fs.files.set(
      "/home/u/.ratel/config.json",
      `${JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      })}\n`,
    );
    const ctx = makeCtx(fs, { flags: { name: "fs" } });
    await runRemove(ctx);
    const parsed = JSON.parse(fs.files.get("/home/u/.ratel/config.json") as string);
    expect(parsed.mcpServers.fs).toBeUndefined();
  });
});
