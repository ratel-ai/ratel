import { describe, expect, it } from "vitest";
import type { BackupFs } from "../backup.js";
import type { ClaudeFs } from "../claude.js";
import type { JsonFs } from "../io.js";
import type { ResolvedBin } from "../locate-bin.js";
import { type PromptAdapter, silentPromptAdapter } from "../prompts.js";
import { runLink } from "./link.js";
import type { HandlerCtx } from "./types.js";

const HOME = "/home/u";
const ROOT = "/r";
const BIN: ResolvedBin = { command: "ratel", args: [], source: "path" };

const HOME_CLAUDE = "/home/u/.claude.json";
const PROJECT_MCP = "/r/.mcp.json";
const RATEL_USER = "/home/u/.ratel/config.json";
const RATEL_PROJECT = "/r/.ratel/config.json";

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

function ctxOf(
  fs: MemFs,
  prompts: PromptAdapter = silentPromptAdapter(),
  withProjectRoot = true,
): { ctx: HandlerCtx; logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    ctx: {
      argv: { group: "mcp", verb: "link", configPaths: [], rest: [], extras: [], flags: {} },
      env: { homeDir: HOME, projectRoot: withProjectRoot ? ROOT : undefined },
      fs,
      log: (m) => logs.push(m),
      prompts,
    },
  };
}

function autoConfirm(): PromptAdapter {
  return {
    ...silentPromptAdapter(),
    async confirm() {
      return true;
    },
  };
}

describe("runLink", () => {
  it("rewrites Claude global to point at Ratel for entries already in Ratel global", async () => {
    const fs = new MemFs();
    fs.files.set(
      RATEL_USER,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: {
          fs: { type: "stdio", command: "echo" },
          other: { type: "stdio", command: "elsewhere" },
        },
      }),
    );
    const { ctx } = ctxOf(fs, autoConfirm(), false);
    await runLink(ctx, { bin: BIN, yes: true });

    const claude = JSON.parse(fs.files.get(HOME_CLAUDE) as string);
    expect(claude.mcpServers.ratel).toEqual({
      type: "stdio",
      command: "ratel",
      args: ["serve", "--config", RATEL_USER],
    });
    // The covered entry was removed from Claude.
    expect(claude.mcpServers.fs).toBeUndefined();
    // The uncovered entry stays.
    expect(claude.mcpServers.other).toEqual({ type: "stdio", command: "elsewhere" });
  });

  it("does not touch the Ratel global config", async () => {
    const fs = new MemFs();
    const ratelBefore = JSON.stringify({
      mcpServers: { fs: { type: "stdio", command: "echo" } },
    });
    fs.files.set(RATEL_USER, ratelBefore);
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    const { ctx } = ctxOf(fs, autoConfirm(), false);
    await runLink(ctx, { bin: BIN, yes: true });
    expect(fs.files.get(RATEL_USER)).toBe(ratelBefore);
  });

  it("no-ops when no Claude entries are also in Ratel", async () => {
    const fs = new MemFs();
    fs.files.set(
      RATEL_USER,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { other: { type: "stdio", command: "elsewhere" } },
      }),
    );
    const claudeBefore = fs.files.get(HOME_CLAUDE);
    const { ctx } = ctxOf(fs, autoConfirm(), false);
    await runLink(ctx, { bin: BIN, yes: true });
    expect(fs.files.get(HOME_CLAUDE)).toBe(claudeBefore);
  });

  it("idempotent: running twice produces no further changes", async () => {
    const fs = new MemFs();
    fs.files.set(
      RATEL_USER,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    const { ctx } = ctxOf(fs, autoConfirm(), false);
    await runLink(ctx, { bin: BIN, yes: true });
    const after1 = fs.files.get(HOME_CLAUDE);
    await runLink(ctx, { bin: BIN, yes: true });
    expect(fs.files.get(HOME_CLAUDE)).toBe(after1);
  });

  it("declines cleanly: leaves Claude untouched when the user says no", async () => {
    const fs = new MemFs();
    fs.files.set(
      RATEL_USER,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    const claudeBefore = JSON.stringify({
      mcpServers: { fs: { type: "stdio", command: "echo" } },
    });
    fs.files.set(HOME_CLAUDE, claudeBefore);
    const decline: PromptAdapter = {
      ...silentPromptAdapter(),
      async confirm() {
        return false;
      },
    };
    const { ctx } = ctxOf(fs, decline, false);
    await runLink(ctx, { bin: BIN });
    expect(fs.files.get(HOME_CLAUDE)).toBe(claudeBefore);
  });

  it("links project scope: rewrites <root>/.mcp.json with the [global, project] arg chain", async () => {
    const fs = new MemFs();
    fs.files.set(
      RATEL_PROJECT,
      JSON.stringify({
        mcpServers: { proj: { type: "stdio", command: "echo" } },
      }),
    );
    fs.files.set(
      PROJECT_MCP,
      JSON.stringify({
        mcpServers: { proj: { type: "stdio", command: "echo" } },
      }),
    );
    const { ctx } = ctxOf(fs, autoConfirm());
    await runLink(ctx, { bin: BIN, yes: true });
    const claudeProj = JSON.parse(fs.files.get(PROJECT_MCP) as string);
    expect(claudeProj.mcpServers.ratel.args).toEqual([
      "serve",
      "--config",
      RATEL_USER,
      "--config",
      RATEL_PROJECT,
    ]);
  });

  it("captures a backup before writing", async () => {
    const fs = new MemFs();
    fs.files.set(
      RATEL_USER,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    const { ctx } = ctxOf(fs, autoConfirm(), false);
    await runLink(ctx, { bin: BIN, yes: true });
    const backupKeys = Array.from(fs.files.keys()).filter((k) =>
      k.startsWith("/home/u/.ratel/backups/"),
    );
    expect(backupKeys.length).toBeGreaterThan(0);
  });
});
