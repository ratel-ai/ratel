import { describe, expect, it } from "vitest";
import type { ParsedArgs } from "../args.js";
import type { BackupFs } from "../backup.js";
import type { ClaudeFs } from "../claude.js";
import type { HierarchyEnv } from "../hierarchy.js";
import type { JsonFs } from "../io.js";
import { silentPromptAdapter } from "../prompts.js";
import { runMcpList } from "./mcp-list.js";
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
        verb: "list",
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

describe("runMcpList", () => {
  it("prints a friendly message when no Ratel scope contains any entry", async () => {
    const fs = new MemFs();
    const { ctx, logs } = makeCtx(fs, {});
    await runMcpList(ctx);
    expect(logs.join("\n")).toMatch(/no MCP servers/i);
  });

  it("lists entries grouped by scope, with type and a summary", async () => {
    const fs = new MemFs();
    fs.files.set(
      "/home/u/.ratel/config.json",
      `${JSON.stringify({
        mcpServers: {
          fs: { type: "stdio", command: "echo" },
          remote: { type: "http", url: "https://x" },
        },
      })}\n`,
    );
    fs.files.set(
      "/r/.ratel/config.json",
      `${JSON.stringify({
        mcpServers: { proj: { type: "stdio", command: "npx", args: ["@p/y"] } },
      })}\n`,
    );

    const { ctx, logs } = makeCtx(fs, {});
    await runMcpList(ctx);
    const out = logs.join("\n");
    expect(out).toMatch(/user/);
    expect(out).toMatch(/project/);
    expect(out).toMatch(/fs/);
    expect(out).toMatch(/echo/);
    expect(out).toMatch(/remote/);
    expect(out).toMatch(/https:\/\/x/);
    expect(out).toMatch(/proj/);
  });

  it("skips scopes whose config files don't exist", async () => {
    const fs = new MemFs();
    fs.files.set(
      "/home/u/.ratel/config.json",
      `${JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } })}\n`,
    );
    const { ctx, logs } = makeCtx(fs, {});
    await runMcpList(ctx);
    const out = logs.join("\n");
    expect(out).toMatch(/user/);
    expect(out).not.toMatch(/project/);
    expect(out).not.toMatch(/local/);
  });

  it("shows an empty-section header when a scope's config file exists but has no entries", async () => {
    const fs = new MemFs();
    fs.files.set("/home/u/.ratel/config.json", `${JSON.stringify({ mcpServers: {} })}\n`);
    const { ctx, logs } = makeCtx(fs, {});
    await runMcpList(ctx);
    expect(logs.join("\n")).toMatch(/no MCP servers/i);
  });

  it("works when no project root is configured (only user scope is checked)", async () => {
    const fs = new MemFs();
    fs.files.set(
      "/home/u/.ratel/config.json",
      `${JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } })}\n`,
    );
    const { ctx, logs } = makeCtx(fs, { env: { homeDir: HOME } });
    await runMcpList(ctx);
    expect(logs.join("\n")).toMatch(/fs/);
  });

  it("annotates http entries with their auth status: needs auth (no file), ok (valid), expired (past expires_at)", async () => {
    const fs = new MemFs();
    fs.files.set(
      "/home/u/.ratel/config.json",
      `${JSON.stringify({
        mcpServers: {
          stdio_one: { type: "stdio", command: "echo" },
          locked: { type: "http", url: "https://locked.example" },
          fresh: { type: "http", url: "https://fresh.example" },
          stale: { type: "http", url: "https://stale.example" },
        },
      })}\n`,
    );
    fs.files.set(
      "/home/u/.ratel/oauth/fresh.json",
      JSON.stringify({
        tokens: { access_token: "abc", token_type: "Bearer" },
        expires_at: Date.now() + 60_000,
      }),
    );
    fs.files.set(
      "/home/u/.ratel/oauth/stale.json",
      JSON.stringify({
        tokens: { access_token: "abc", token_type: "Bearer" },
        expires_at: Date.now() - 60_000,
      }),
    );

    const { ctx, logs } = makeCtx(fs, {});
    await runMcpList(ctx);
    const out = logs.join("\n");

    // stdio rows show n/a for auth.
    expect(out).toMatch(/stdio_one[^\n]*n\/a/);
    // missing token file → needs auth.
    expect(out).toMatch(/locked[^\n]*needs auth/);
    // valid expires_at → ok.
    expect(out).toMatch(/fresh[^\n]*ok/);
    // past expires_at → expired.
    expect(out).toMatch(/stale[^\n]*expired/);
  });
});
