import { describe, expect, it } from "vitest";
import type { ParsedArgs } from "../args.js";
import type { BackupFs } from "../backup.js";
import type { ClaudeFs } from "../claude.js";
import type { HierarchyEnv } from "../hierarchy.js";
import type { JsonFs } from "../io.js";
import { silentPromptAdapter } from "../prompts.js";
import { runAdd } from "./add.js";
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
    argv: { subcommand: "add", configPaths: [], rest: [], flags: args.flags },
    env: args.env ?? { homeDir: HOME, projectRoot: ROOT },
    fs,
    log: () => {},
    prompts: silentPromptAdapter(),
  };
}

describe("runAdd", () => {
  it("writes a new entry into the requested Ratel scope and creates the file if missing", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "global", name: "fs", command: "echo" },
    });
    await runAdd(ctx);
    const parsed = JSON.parse(fs.files.get("/home/u/.ratel/config.json") as string);
    expect(parsed.mcpServers.fs).toEqual({ type: "stdio", command: "echo" });
  });

  it("accepts --entry-json for richer entries", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: {
        scope: "global",
        name: "remote",
        "entry-json": JSON.stringify({
          type: "http",
          url: "https://x",
          headers: { Auth: "Bearer y" },
        }),
      },
    });
    await runAdd(ctx);
    const parsed = JSON.parse(fs.files.get("/home/u/.ratel/config.json") as string);
    expect(parsed.mcpServers.remote).toEqual({
      type: "http",
      url: "https://x",
      headers: { Auth: "Bearer y" },
    });
  });

  it("refuses to overwrite an existing entry without --force", async () => {
    const fs = new MemFs();
    fs.files.set(
      "/home/u/.ratel/config.json",
      `${JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "old" } },
      })}\n`,
    );
    const ctx = makeCtx(fs, {
      flags: { scope: "global", name: "fs", command: "new" },
    });
    await expect(runAdd(ctx)).rejects.toThrow(/already exists/);
  });

  it("overwrites an existing entry with --force", async () => {
    const fs = new MemFs();
    fs.files.set(
      "/home/u/.ratel/config.json",
      `${JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "old" } },
      })}\n`,
    );
    const ctx = makeCtx(fs, {
      flags: { scope: "global", name: "fs", command: "new", force: true },
    });
    await runAdd(ctx);
    const parsed = JSON.parse(fs.files.get("/home/u/.ratel/config.json") as string);
    expect(parsed.mcpServers.fs.command).toBe("new");
  });

  it("captures a backup before writing", async () => {
    const fs = new MemFs();
    fs.files.set("/home/u/.ratel/config.json", `${JSON.stringify({ mcpServers: {} })}\n`);
    const ctx = makeCtx(fs, {
      flags: { scope: "global", name: "fs", command: "echo" },
    });
    await runAdd(ctx);
    const backupDirs = Array.from(fs.files.keys()).filter((k) =>
      k.startsWith("/home/u/.ratel/backups/"),
    );
    expect(backupDirs.length).toBeGreaterThan(0);
  });

  it("persists --description on the entry alongside --command", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: {
        scope: "global",
        name: "fs",
        command: "echo",
        description: "echo for tests",
      },
    });
    await runAdd(ctx);
    const parsed = JSON.parse(fs.files.get("/home/u/.ratel/config.json") as string);
    expect(parsed.mcpServers.fs).toEqual({
      type: "stdio",
      command: "echo",
      description: "echo for tests",
    });
  });

  it("--description overlays on top of --entry-json", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: {
        scope: "global",
        name: "remote",
        "entry-json": JSON.stringify({ type: "http", url: "https://x" }),
        description: "the remote one",
      },
    });
    await runAdd(ctx);
    const parsed = JSON.parse(fs.files.get("/home/u/.ratel/config.json") as string);
    expect(parsed.mcpServers.remote.description).toBe("the remote one");
  });

  it("omits description when --description is not provided", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "global", name: "fs", command: "echo" },
    });
    await runAdd(ctx);
    const parsed = JSON.parse(fs.files.get("/home/u/.ratel/config.json") as string);
    expect(parsed.mcpServers.fs.description).toBeUndefined();
  });

  it("surfaces parseConfig errors for an invalid entry", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: {
        scope: "global",
        name: "weird",
        "entry-json": JSON.stringify({ type: "http" }),
      },
    });
    await expect(runAdd(ctx)).rejects.toThrow(/url/);
  });

  it("errors when project scope requested without a project root", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "project", name: "fs", command: "echo" },
      env: { homeDir: HOME },
    });
    await expect(runAdd(ctx)).rejects.toThrow();
  });

  it("errors when --scope is missing", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, { flags: { name: "fs", command: "echo" } });
    await expect(runAdd(ctx)).rejects.toThrow(/--scope/);
  });

  it("errors when --name is missing", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, { flags: { scope: "global", command: "echo" } });
    await expect(runAdd(ctx)).rejects.toThrow(/--name/);
  });
});
