import { describe, expect, it } from "vitest";
import type { BackupFs } from "../backup.js";
import type { ClaudeFs } from "../claude.js";
import type { JsonFs } from "../io.js";
import type { ResolvedBin } from "../locate-bin.js";
import { CANCEL_SYMBOL, type PromptAdapter, silentPromptAdapter } from "../prompts.js";
import { runImport } from "./import.js";
import type { HandlerCtx } from "./types.js";

const HOME = "/home/u";
const ROOT = "/r";
const BIN: ResolvedBin = { command: "ratel", args: [], source: "path" };

const HOME_CLAUDE = "/home/u/.claude.json";
const PROJECT_MCP = "/r/.mcp.json";
const RATEL_USER = "/home/u/.ratel/config.json";
const RATEL_PROJECT = "/r/.ratel/config.json";
const RATEL_LOCAL = "/r/.ratel/config.local.json";

class MemFs implements BackupFs, JsonFs, ClaudeFs {
  files = new Map<string, string>();
  failNextWriteAt: string | null = null;
  async read(p: string) {
    return this.files.has(p) ? (this.files.get(p) as string) : null;
  }
  async write(p: string, c: string) {
    this.files.set(p, c);
  }
  async writeAtomic(p: string, c: string) {
    if (this.failNextWriteAt === p) {
      this.failNextWriteAt = null;
      throw new Error(`fail-${p}`);
    }
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
      argv: { group: "mcp", verb: "import", configPaths: [], rest: [], extras: [], flags: {} },
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
    async multiselect(opts) {
      return opts.options.map((o) => o.value) as unknown as never;
    },
    async text() {
      return "";
    },
  };
}

function selectingPrompts(selected: string[]): PromptAdapter {
  return {
    ...autoConfirm(),
    async multiselect(opts) {
      const map = new Map<string, string>();
      for (const o of opts.options) {
        const tag = o.value as string;
        const name = tag.split(":")[1] ?? tag;
        map.set(name, tag);
      }
      const tags = selected
        .map((n) => map.get(n))
        .filter((x): x is string => typeof x === "string");
      return tags as unknown as never;
    },
  };
}

function decliningStageB(): PromptAdapter {
  let stage = 0;
  return {
    ...autoConfirm(),
    async confirm() {
      stage += 1;
      return stage === 1; // accept Stage A, decline Stage B
    },
  };
}

describe("runImport", () => {
  it("early-exits with a 'no MCPs found' note when nothing exists", async () => {
    const fs = new MemFs();
    const notes: string[] = [];
    const stub = { ...silentPromptAdapter(), note: (m: string) => notes.push(m) };
    const { ctx } = ctxOf(fs, stub);
    const m = await runImport(ctx, { bin: BIN });
    expect(m).toBeNull();
    expect(notes.join("\n")).toMatch(/no Claude/i);
    expect(fs.files.size).toBe(0);
  });

  it("global-only: moves entries into Ratel global, writes ratel entry into ~/.claude.json", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    const { ctx } = ctxOf(fs, autoConfirm(), false);
    await runImport(ctx, { bin: BIN, yes: true });

    expect(fs.files.has(RATEL_USER)).toBe(true);
    const ratelUser = JSON.parse(fs.files.get(RATEL_USER) as string);
    expect(ratelUser.mcpServers.fs).toEqual({ type: "stdio", command: "echo" });

    const claude = JSON.parse(fs.files.get(HOME_CLAUDE) as string);
    expect(claude.mcpServers.ratel).toEqual({
      type: "stdio",
      command: "ratel",
      args: ["mcp", "serve", "--config", RATEL_USER],
    });
  });

  it("global+project: writes both Claude files with the right --config arg lists", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    fs.files.set(
      PROJECT_MCP,
      JSON.stringify({
        mcpServers: { proj: { type: "stdio", command: "echo" } },
      }),
    );
    const { ctx } = ctxOf(fs, autoConfirm());
    await runImport(ctx, { bin: BIN, yes: true });

    const claudeProj = JSON.parse(fs.files.get(PROJECT_MCP) as string);
    expect(claudeProj.mcpServers.ratel.args).toEqual([
      "mcp",
      "serve",
      "--config",
      RATEL_USER,
      "--config",
      RATEL_PROJECT,
    ]);
  });

  it("global+project+local: writes three Ratel entries with right chains and one merged write to ~/.claude.json", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
        projects: {
          [ROOT]: { mcpServers: { local: { type: "stdio", command: "echo" } } },
        },
      }),
    );
    fs.files.set(
      PROJECT_MCP,
      JSON.stringify({
        mcpServers: { proj: { type: "stdio", command: "echo" } },
      }),
    );
    const { ctx } = ctxOf(fs, autoConfirm());
    await runImport(ctx, { bin: BIN, yes: true });

    const claude = JSON.parse(fs.files.get(HOME_CLAUDE) as string);
    expect(claude.mcpServers.ratel.args).toEqual(["mcp", "serve", "--config", RATEL_USER]);
    expect(claude.projects[ROOT].mcpServers.ratel.args).toEqual([
      "mcp",
      "serve",
      "--config",
      RATEL_USER,
      "--config",
      RATEL_PROJECT,
      "--config",
      RATEL_LOCAL,
    ]);
    expect(JSON.parse(fs.files.get(PROJECT_MCP) as string).mcpServers.ratel.args).toEqual([
      "mcp",
      "serve",
      "--config",
      RATEL_USER,
      "--config",
      RATEL_PROJECT,
    ]);
  });

  it("aborts cleanly when the user cancels the confirm step (no writes, no backup)", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    const decline: PromptAdapter = {
      ...silentPromptAdapter(),
      async confirm() {
        return false;
      },
    };
    const { ctx } = ctxOf(fs, decline, false);
    await runImport(ctx, { bin: BIN });

    // Original file untouched; no Ratel global created; no backups.
    expect(fs.files.has(RATEL_USER)).toBe(false);
    expect(JSON.parse(fs.files.get(HOME_CLAUDE) as string).mcpServers.fs).toBeDefined();
    const backupKeys = Array.from(fs.files.keys()).filter((k) =>
      k.startsWith("/home/u/.ratel/backups/"),
    );
    expect(backupKeys).toEqual([]);
  });

  it("treats a cancel-symbol confirm as abort", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    const cancelStub: PromptAdapter = {
      ...silentPromptAdapter(),
      async confirm() {
        return CANCEL_SYMBOL;
      },
    };
    const { ctx } = ctxOf(fs, cancelStub, false);
    await runImport(ctx, { bin: BIN });
    expect(fs.files.has(RATEL_USER)).toBe(false);
  });

  it("--dry-run skips execution and logs what would be written", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    const { ctx, logs } = ctxOf(fs, autoConfirm(), false);
    await runImport(ctx, { bin: BIN, yes: true, dryRun: true });

    expect(fs.files.has(RATEL_USER)).toBe(false);
    expect(logs.join("\n")).toMatch(/would write/);
    expect(logs.join("\n")).toMatch(/\/home\/u\/\.ratel\/config\.json/);
  });

  it("--yes skips the confirm prompt entirely", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    let confirmCalled = false;
    const counted: PromptAdapter = {
      ...silentPromptAdapter(),
      async confirm() {
        confirmCalled = true;
        return true;
      },
    };
    const { ctx } = ctxOf(fs, counted, false);
    await runImport(ctx, { bin: BIN, yes: true });
    expect(confirmCalled).toBe(false);
    expect(fs.files.has(RATEL_USER)).toBe(true);
  });

  it("logs an undo hint if executor fails mid-flight", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    fs.failNextWriteAt = HOME_CLAUDE;
    const { ctx, logs } = ctxOf(fs, autoConfirm(), false);
    await expect(runImport(ctx, { bin: BIN, yes: true })).rejects.toThrow();
    expect(logs.join("\n")).toMatch(/undo/);
  });

  it("declining Stage B leaves Ratel configs in place and Claude untouched, with an undo+link hint", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: {
          fs: { type: "stdio", command: "echo" },
          other: { type: "stdio", command: "echo-other" },
        },
      }),
    );
    const { ctx, logs } = ctxOf(fs, decliningStageB(), false);
    await runImport(ctx, { bin: BIN });

    // Stage A applied: Ratel global has the entries.
    expect(fs.files.has(RATEL_USER)).toBe(true);
    const ratelUser = JSON.parse(fs.files.get(RATEL_USER) as string);
    expect(ratelUser.mcpServers.fs).toBeDefined();
    expect(ratelUser.mcpServers.other).toBeDefined();

    // Stage B declined: Claude is untouched.
    const claude = JSON.parse(fs.files.get(HOME_CLAUDE) as string);
    expect(claude.mcpServers.ratel).toBeUndefined();
    expect(claude.mcpServers.fs).toBeDefined();

    // Hint mentions link or re-running import.
    expect(logs.join("\n")).toMatch(/link|import/i);
  });

  it("multiselect deselects an entry: only selected ones land in Ratel, deselected ones stay in Claude", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: {
          fs: { type: "stdio", command: "echo" },
          other: { type: "stdio", command: "echo-other" },
        },
      }),
    );
    const prompts = selectingPrompts(["fs"]);
    const { ctx } = ctxOf(fs, prompts, false);
    await runImport(ctx, { bin: BIN });

    const ratelUser = JSON.parse(fs.files.get(RATEL_USER) as string);
    expect(ratelUser.mcpServers.fs).toBeDefined();
    expect(ratelUser.mcpServers.other).toBeUndefined();

    const claude = JSON.parse(fs.files.get(HOME_CLAUDE) as string);
    expect(claude.mcpServers.ratel).toBeDefined();
    expect(claude.mcpServers.other).toEqual({ type: "stdio", command: "echo-other" });
    expect(claude.mcpServers.fs).toBeUndefined();
  });

  it("after declining Stage B, re-running offers Stage B again (Stage A is a no-op)", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    const { ctx } = ctxOf(fs, decliningStageB(), false);
    await runImport(ctx, { bin: BIN });
    expect(JSON.parse(fs.files.get(HOME_CLAUDE) as string).mcpServers.ratel).toBeUndefined();

    // Re-run: this time accept both stages.
    const { ctx: ctx2 } = ctxOf(fs, autoConfirm(), false);
    await runImport(ctx2, { bin: BIN });
    expect(JSON.parse(fs.files.get(HOME_CLAUDE) as string).mcpServers.ratel).toBeDefined();
  });

  it("captures and prompts for an optional description on each selected entry without one", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    const prompts: PromptAdapter = {
      ...autoConfirm(),
      async multiselect(opts) {
        return opts.options.map((o) => o.value) as unknown as never;
      },
      async text() {
        return "filesystem stuff";
      },
    };
    const { ctx } = ctxOf(fs, prompts, false);
    await runImport(ctx, { bin: BIN });
    const ratelUser = JSON.parse(fs.files.get(RATEL_USER) as string);
    expect(ratelUser.mcpServers.fs.description).toBe("filesystem stuff");
  });

  it("always shows an upstream-instructions note (with an empty marker when none), recommends a brief description, and seeds initialValue with the preview", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: {
          fs: { type: "stdio", command: "echo" },
          remote: { type: "http", url: "https://x" },
        },
      }),
    );
    const FS_INSTRUCTIONS = "First line of fs instructions.\nSecond paragraph here.";
    const seen: Array<{
      message: string;
      placeholder: string | undefined;
      initialValue: string | undefined;
    }> = [];
    const notes: Array<{ message: string; title: string | undefined }> = [];
    const spinnerCalls: string[] = [];
    const probeCalls: string[] = [];
    const prompts: PromptAdapter = {
      ...autoConfirm(),
      note(m, title) {
        notes.push({ message: m, title });
      },
      spinner() {
        return {
          start: (m?: string) => {
            spinnerCalls.push(`start:${m ?? ""}`);
          },
          stop: (m?: string) => {
            spinnerCalls.push(`stop:${m ?? ""}`);
          },
          message: () => {},
        };
      },
      async multiselect(opts) {
        return opts.options.map((o) => o.value) as unknown as never;
      },
      async text(opts) {
        seen.push({
          message: opts.message,
          placeholder: opts.placeholder,
          initialValue: opts.initialValue,
        });
        return "";
      },
    };
    const { ctx } = ctxOf(fs, prompts, false);
    await runImport(ctx, {
      bin: BIN,
      probe: async (name) => {
        probeCalls.push(name);
        return name === "fs" ? FS_INSTRUCTIONS : undefined;
      },
    });

    expect(probeCalls.sort()).toEqual(["fs", "remote"]);
    expect(spinnerCalls[0]).toMatch(/^start:Spinning up/);
    expect(spinnerCalls.at(-1)).toMatch(/^stop:/);

    const fsNote = notes.find((n) => n.title?.includes("fs"));
    expect(fsNote?.message).toBe(FS_INSTRUCTIONS);
    const remoteNote = notes.find((n) => n.title?.includes("remote"));
    expect(remoteNote).toBeDefined();
    expect(remoteNote?.message).toMatch(/none provided/i);

    const fsPrompt = seen.find((s) => s.message.includes(`"fs"`));
    const remotePrompt = seen.find((s) => s.message.includes(`"remote"`));
    expect(fsPrompt?.message).toMatch(/brief.*concise/i);
    expect(fsPrompt?.initialValue).toBe("First line of fs instructions.");
    expect(fsPrompt?.placeholder).toBeUndefined();
    expect(remotePrompt?.initialValue).toBe("");
    expect(remotePrompt?.placeholder).toMatch(/leave blank/i);

    const ratelUser = JSON.parse(fs.files.get(RATEL_USER) as string);
    expect(ratelUser.mcpServers.fs.description).toBeUndefined();
    expect(ratelUser.mcpServers.remote.description).toBeUndefined();
  });

  it("truncates a long single-line upstream instruction to a ≤120-char editable initialValue", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    const long = `${"x ".repeat(200)}END`;
    const seen: Array<{ initialValue: string | undefined }> = [];
    const prompts: PromptAdapter = {
      ...autoConfirm(),
      async multiselect(opts) {
        return opts.options.map((o) => o.value) as unknown as never;
      },
      async text(opts) {
        seen.push({ initialValue: opts.initialValue });
        return "";
      },
    };
    const { ctx } = ctxOf(fs, prompts, false);
    await runImport(ctx, { bin: BIN, probe: async () => long });

    const iv = seen[0]?.initialValue ?? "";
    expect(iv.endsWith("…")).toBe(true);
    expect(iv.length).toBeLessThanOrEqual(120);
  });

  it("does not call the probe for entries that already have a description in Claude", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: {
          fs: { type: "stdio", command: "echo", description: "user-set" },
        },
      }),
    );
    const probeCalls: string[] = [];
    const { ctx } = ctxOf(fs, autoConfirm(), false);
    await runImport(ctx, {
      bin: BIN,
      probe: async (name) => {
        probeCalls.push(name);
        return "from upstream";
      },
    });
    expect(probeCalls).toEqual([]);
    const ratelUser = JSON.parse(fs.files.get(RATEL_USER) as string);
    expect(ratelUser.mcpServers.fs.description).toBe("user-set");
  });

  it("--yes skips probing entirely (non-interactive flow)", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    const probeCalls: string[] = [];
    const { ctx } = ctxOf(fs, autoConfirm(), false);
    await runImport(ctx, {
      bin: BIN,
      yes: true,
      probe: async (name) => {
        probeCalls.push(name);
        return "should not be used";
      },
    });
    expect(probeCalls).toEqual([]);
    const ratelUser = JSON.parse(fs.files.get(RATEL_USER) as string);
    expect(ratelUser.mcpServers.fs.description).toBeUndefined();
  });

  it("re-running after a successful import produces an empty plan (idempotent)", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    const { ctx } = ctxOf(fs, autoConfirm(), false);
    await runImport(ctx, { bin: BIN, yes: true });

    const filesBefore = new Map(fs.files);
    await runImport(ctx, { bin: BIN, yes: true });
    // No changes.
    expect(fs.files.size).toBe(filesBefore.size);
    for (const [k, v] of filesBefore) {
      expect(fs.files.get(k)).toBe(v);
    }
  });
});
