import { describe, expect, it } from "vitest";
import type { ParsedArgs } from "../args.js";
import type { BackupFs } from "../backup.js";
import type { ClaudeFs } from "../claude.js";
import type { HierarchyEnv } from "../hierarchy.js";
import type { JsonFs } from "../io.js";
import { silentPromptAdapter } from "../prompts.js";
import { runMcpGet } from "./get.js";
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
  async list() {
    return [];
  }
}

function makeCtx(
  fs: MemFs,
  args: { flags?: ParsedArgs["flags"]; rest?: string[]; env?: HierarchyEnv },
): { ctx: HandlerCtx; logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    ctx: {
      argv: {
        group: "mcp",
        verb: "get",
        configPaths: [],
        rest: args.rest ?? [],
        extras: [],
        flags: args.flags ?? {},
      },
      env: args.env ?? { homeDir: HOME, projectRoot: ROOT },
      fs,
      log: (m) => logs.push(m),
      prompts: silentPromptAdapter(),
    },
  };
}

describe("runMcpGet", () => {
  it("prints the resolved entry and its scope (most-specific wins)", async () => {
    const fs = new MemFs();
    fs.files.set(
      "/home/u/.ratel/config.json",
      `${JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "user-echo" } } })}\n`,
    );
    fs.files.set(
      "/r/.ratel/config.json",
      `${JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "proj-echo" } } })}\n`,
    );

    const { ctx, logs } = makeCtx(fs, { rest: ["fs"] });
    await runMcpGet(ctx);
    const out = logs.join("\n");
    expect(out).toMatch(/project/);
    expect(out).toMatch(/proj-echo/);
    expect(out).not.toMatch(/user-echo/);
  });

  it("respects --scope to disambiguate", async () => {
    const fs = new MemFs();
    fs.files.set(
      "/home/u/.ratel/config.json",
      `${JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "user-echo" } } })}\n`,
    );
    fs.files.set(
      "/r/.ratel/config.json",
      `${JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "proj-echo" } } })}\n`,
    );

    const { ctx, logs } = makeCtx(fs, { rest: ["fs"], flags: { scope: "user" } });
    await runMcpGet(ctx);
    const out = logs.join("\n");
    expect(out).toMatch(/user-echo/);
  });

  it("errors when the entry is not found in any scope", async () => {
    const fs = new MemFs();
    const { ctx } = makeCtx(fs, { rest: ["nope"] });
    await expect(runMcpGet(ctx)).rejects.toThrow(/nope/);
  });

  it("errors when --scope is given but the entry is missing in that scope", async () => {
    const fs = new MemFs();
    fs.files.set(
      "/r/.ratel/config.json",
      `${JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "x" } } })}\n`,
    );
    const { ctx } = makeCtx(fs, { rest: ["fs"], flags: { scope: "user" } });
    await expect(runMcpGet(ctx)).rejects.toThrow(/user/);
  });

  it("errors when no name positional is given", async () => {
    const fs = new MemFs();
    const { ctx } = makeCtx(fs, {});
    await expect(runMcpGet(ctx)).rejects.toThrow(/name/);
  });

  it("rejects --scope global with a hint to use --scope user", async () => {
    const fs = new MemFs();
    const { ctx } = makeCtx(fs, { rest: ["fs"], flags: { scope: "global" } });
    await expect(runMcpGet(ctx)).rejects.toThrow(/user/);
  });
});
