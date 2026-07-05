import type { AuthFlowOptions, AuthFlowResult } from "@ratel-ai/mcp-server";
import { describe, expect, it, vi } from "vitest";
import type { ParsedArgs } from "../args.js";
import type { BackupFs } from "../backup.js";
import type { ClaudeFs } from "../claude.js";
import type { HierarchyEnv } from "../hierarchy.js";
import type { JsonFs } from "../io.js";
import { silentPromptAdapter } from "../prompts.js";
import { runMcpAuth } from "./mcp-auth.js";
import type { HandlerCtx } from "./types.js";

const HOME = "/home/u";

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
  args: {
    flags?: ParsedArgs["flags"];
    rest?: string[];
    env?: HierarchyEnv;
    log?: (m: string) => void;
  },
): HandlerCtx {
  return {
    argv: {
      group: "mcp",
      verb: "auth",
      configPaths: [],
      rest: args.rest ?? [],
      extras: [],
      flags: args.flags ?? {},
    },
    env: args.env ?? { homeDir: HOME, projectRoot: undefined },
    fs,
    log: args.log ?? (() => {}),
    prompts: silentPromptAdapter(),
  };
}

const RATEL_USER_PATH = "/home/u/.ratel/config.json";

describe("runMcpAuth", () => {
  it("calls the orchestrator without name when none is given on the command line", async () => {
    const fs = new MemFs();
    fs.files.set(
      RATEL_USER_PATH,
      JSON.stringify({
        mcpServers: {
          stripe: { type: "http", url: "https://mcp.stripe.example" },
          fs: { type: "stdio", command: "x" },
        },
      }),
    );
    const captured: AuthFlowOptions[] = [];
    const ctx = makeCtx(fs, { flags: {} });

    await runMcpAuth(ctx, {
      authRunner: async (opts: AuthFlowOptions) => {
        captured.push(opts);
        return [{ name: "stripe", status: "authorized" }];
      },
    });

    expect(captured).toEqual([{}]);
  });

  it("forwards a positional name to the orchestrator", async () => {
    const fs = new MemFs();
    fs.files.set(
      RATEL_USER_PATH,
      JSON.stringify({
        mcpServers: { stripe: { type: "http", url: "https://mcp.stripe.example" } },
      }),
    );
    const captured: AuthFlowOptions[] = [];
    const ctx = makeCtx(fs, { rest: ["stripe"] });

    await runMcpAuth(ctx, {
      authRunner: async (opts) => {
        captured.push(opts);
        return [{ name: "stripe", status: "authorized" }];
      },
    });

    expect(captured).toEqual([{ name: "stripe" }]);
  });

  it("logs a per-upstream summary with status", async () => {
    const fs = new MemFs();
    fs.files.set(
      RATEL_USER_PATH,
      JSON.stringify({
        mcpServers: { stripe: { type: "http", url: "https://x" } },
      }),
    );
    const logs: string[] = [];
    const ctx = makeCtx(fs, { log: (m) => logs.push(m) });

    const results: AuthFlowResult[] = [
      { name: "stripe", status: "authorized" },
      { name: "linear", status: "failed", reason: "user denied" },
    ];
    await runMcpAuth(ctx, { authRunner: async () => results });

    const all = logs.join("\n");
    expect(all).toMatch(/stripe.*authorized/);
    expect(all).toMatch(/linear.*failed.*user denied/);
  });

  it("warns and exits cleanly when no Ratel config is found in any scope", async () => {
    const fs = new MemFs();
    const logs: string[] = [];
    const ctx = makeCtx(fs, { log: (m) => logs.push(m) });
    const runner = vi.fn();

    await runMcpAuth(ctx, { authRunner: runner });
    expect(runner).not.toHaveBeenCalled();
    expect(logs.join("\n")).toMatch(/no.*config|nothing to auth/i);
  });

  it("renders the new mode field per row in the summary", async () => {
    const fs = new MemFs();
    fs.files.set(
      RATEL_USER_PATH,
      JSON.stringify({
        mcpServers: { stripe: { type: "http", url: "https://x" } },
      }),
    );
    const logs: string[] = [];
    const ctx = makeCtx(fs, { log: (m) => logs.push(m) });

    const results: AuthFlowResult[] = [
      { name: "stripe", status: "authorized", mode: "refresh" },
      { name: "linear", status: "authorized", mode: "interactive" },
    ];
    await runMcpAuth(ctx, { authRunner: async () => results });

    const all = logs.join("\n");
    expect(all).toMatch(/stripe.*authorized.*refreshed/);
    expect(all).toMatch(/linear.*authorized.*re-authed/);
  });

  describe("--check mode", () => {
    it("does not call the runner; reads OAuth stores and prints per-upstream status", async () => {
      const fs = new MemFs();
      fs.files.set(
        RATEL_USER_PATH,
        JSON.stringify({
          mcpServers: {
            linear: { type: "http", url: "https://mcp.linear.example" },
            local: { type: "stdio", command: "x" },
            fresh: { type: "http", url: "https://fresh.example" },
            unconfigured: { type: "http", url: "https://no-tokens.example" },
          },
        }),
      );
      // linear: expired token, refresh available
      fs.files.set(
        "/home/u/.ratel/oauth/linear.json",
        JSON.stringify({
          tokens: { access_token: "old", refresh_token: "rtk", token_type: "Bearer" },
          expires_at: Date.now() - 5 * 60 * 1000,
        }),
      );
      // fresh: comfortably valid
      fs.files.set(
        "/home/u/.ratel/oauth/fresh.json",
        JSON.stringify({
          tokens: { access_token: "ok", refresh_token: "rtk", token_type: "Bearer" },
          expires_at: Date.now() + 23 * 3600 * 1000,
        }),
      );

      const runner = vi.fn();
      const logs: string[] = [];
      const ctx = makeCtx(fs, { flags: { check: true }, log: (m) => logs.push(m) });

      await runMcpAuth(ctx, { authRunner: runner });

      expect(runner).not.toHaveBeenCalled();
      const all = logs.join("\n");
      expect(all).toMatch(/linear\s+\[expired\]/);
      expect(all).toMatch(/local\s+\[n\/a\]/);
      expect(all).toMatch(/fresh\s+\[ok\]/);
      expect(all).toMatch(/unconfigured\s+\[needs auth\]/);
    });
  });

  it("rejects when a positional name is not present in any merged scope", async () => {
    const fs = new MemFs();
    fs.files.set(
      RATEL_USER_PATH,
      JSON.stringify({
        mcpServers: { stripe: { type: "http", url: "https://x" } },
      }),
    );
    const ctx = makeCtx(fs, { rest: ["ghost"] });

    await expect(runMcpAuth(ctx, { authRunner: async () => [] })).rejects.toThrow(/ghost/);
  });
});
