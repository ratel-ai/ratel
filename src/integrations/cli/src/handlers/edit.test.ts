import { describe, expect, it } from "vitest";
import type { ParsedArgs } from "../args.js";
import type { BackupFs } from "../backup.js";
import type { ClaudeFs } from "../claude.js";
import type { HierarchyEnv } from "../hierarchy.js";
import type { JsonFs } from "../io.js";
import { CANCEL_SYMBOL, type PromptAdapter, silentPromptAdapter } from "../prompts.js";
import { runEdit } from "./edit.js";
import type { HandlerCtx } from "./types.js";

const HOME = "/home/u";
const ROOT = "/r";
const GLOBAL_PATH = "/home/u/.ratel/config.json";

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

function seed(fs: MemFs, mcpServers: Record<string, unknown>) {
  fs.files.set(GLOBAL_PATH, `${JSON.stringify({ mcpServers })}\n`);
}

function read(fs: MemFs) {
  return JSON.parse(fs.files.get(GLOBAL_PATH) as string);
}

function makeCtx(
  fs: MemFs,
  args: { flags: ParsedArgs["flags"]; env?: HierarchyEnv; prompts?: PromptAdapter },
): HandlerCtx {
  return {
    argv: { group: "mcp", verb: "edit", configPaths: [], rest: [], extras: [], flags: args.flags },
    env: args.env ?? { homeDir: HOME, projectRoot: ROOT },
    fs,
    log: () => {},
    prompts: args.prompts ?? silentPromptAdapter(),
  };
}

describe("runEdit", () => {
  it("updates description on an existing entry", async () => {
    const fs = new MemFs();
    seed(fs, { ev: { type: "stdio", command: "echo", description: "old" } });
    const ctx = makeCtx(fs, {
      flags: { scope: "user", name: "ev", description: "new" },
    });
    await runEdit(ctx);
    expect(read(fs).mcpServers.ev.description).toBe("new");
    expect(read(fs).mcpServers.ev.command).toBe("echo");
  });

  it("defaults to user scope when --scope is omitted", async () => {
    const fs = new MemFs();
    seed(fs, { ev: { type: "stdio", command: "echo" } });
    const ctx = makeCtx(fs, {
      flags: { name: "ev", description: "new" },
    });
    await runEdit(ctx);
    expect(read(fs).mcpServers.ev.description).toBe("new");
  });

  it("clears description with empty --description=''", async () => {
    const fs = new MemFs();
    seed(fs, { ev: { type: "stdio", command: "echo", description: "old" } });
    const ctx = makeCtx(fs, {
      flags: { scope: "user", name: "ev", description: "" },
    });
    await runEdit(ctx);
    expect(read(fs).mcpServers.ev).toEqual({ type: "stdio", command: "echo" });
  });

  it("updates command and replaces args wholesale when --arg given", async () => {
    const fs = new MemFs();
    seed(fs, { ev: { type: "stdio", command: "old", args: ["a", "b"] } });
    const ctx = makeCtx(fs, {
      flags: { scope: "user", name: "ev", command: "new", arg: ["x", "y", "z"] },
    });
    await runEdit(ctx);
    expect(read(fs).mcpServers.ev).toEqual({
      type: "stdio",
      command: "new",
      args: ["x", "y", "z"],
    });
  });

  it("merges --env entries into existing env and unsets KEY= form", async () => {
    const fs = new MemFs();
    seed(fs, {
      ev: {
        type: "stdio",
        command: "echo",
        env: { A: "1", B: "2", C: "3" },
      },
    });
    const ctx = makeCtx(fs, {
      flags: {
        scope: "user",
        name: "ev",
        env: ["A=10", "B=", "D=4"],
      },
    });
    await runEdit(ctx);
    expect(read(fs).mcpServers.ev.env).toEqual({ A: "10", C: "3", D: "4" });
  });

  it("merges --header entries into existing headers", async () => {
    const fs = new MemFs();
    seed(fs, {
      remote: {
        type: "http",
        url: "https://x",
        headers: { Authorization: "Bearer old", "X-Trace": "1" },
      },
    });
    const ctx = makeCtx(fs, {
      flags: {
        scope: "user",
        name: "remote",
        header: ["Authorization=Bearer new", "X-Trace="],
      },
    });
    await runEdit(ctx);
    expect(read(fs).mcpServers.remote.headers).toEqual({ Authorization: "Bearer new" });
  });

  it("changes type and url on an http entry", async () => {
    const fs = new MemFs();
    seed(fs, { remote: { type: "http", url: "https://old" } });
    const ctx = makeCtx(fs, {
      flags: { scope: "user", name: "remote", url: "https://new" },
    });
    await runEdit(ctx);
    expect(read(fs).mcpServers.remote.url).toBe("https://new");
  });

  it("clears cwd when --cwd ''", async () => {
    const fs = new MemFs();
    seed(fs, { ev: { type: "stdio", command: "echo", cwd: "/tmp" } });
    const ctx = makeCtx(fs, {
      flags: { scope: "user", name: "ev", cwd: "" },
    });
    await runEdit(ctx);
    expect(read(fs).mcpServers.ev.cwd).toBeUndefined();
  });

  it("supports full replacement via --entry-json", async () => {
    const fs = new MemFs();
    seed(fs, { ev: { type: "stdio", command: "echo", description: "old" } });
    const ctx = makeCtx(fs, {
      flags: {
        scope: "user",
        name: "ev",
        "entry-json": JSON.stringify({
          type: "http",
          url: "https://x",
          description: "now remote",
        }),
      },
    });
    await runEdit(ctx);
    expect(read(fs).mcpServers.ev).toEqual({
      type: "http",
      url: "https://x",
      description: "now remote",
    });
  });

  it("rejects --entry-json combined with field flags", async () => {
    const fs = new MemFs();
    seed(fs, { ev: { type: "stdio", command: "echo" } });
    const ctx = makeCtx(fs, {
      flags: {
        scope: "user",
        name: "ev",
        "entry-json": JSON.stringify({ type: "stdio", command: "x" }),
        description: "won't fly",
      },
    });
    await expect(runEdit(ctx)).rejects.toThrow(/entry-json.*field/i);
  });

  it("validates the result and rejects an invalid combination", async () => {
    const fs = new MemFs();
    seed(fs, { ev: { type: "stdio", command: "echo" } });
    const ctx = makeCtx(fs, {
      flags: { scope: "user", name: "ev", command: "" },
    });
    await expect(runEdit(ctx)).rejects.toThrow();
  });

  it("rejects when the entry does not exist at the requested scope", async () => {
    const fs = new MemFs();
    seed(fs, { other: { type: "stdio", command: "x" } });
    const ctx = makeCtx(fs, {
      flags: { scope: "user", name: "ev", description: "x" },
    });
    await expect(runEdit(ctx)).rejects.toThrow(/not found/);
  });

  it("captures a backup before writing", async () => {
    const fs = new MemFs();
    seed(fs, { ev: { type: "stdio", command: "echo" } });
    const ctx = makeCtx(fs, {
      flags: { scope: "user", name: "ev", description: "new" },
    });
    await runEdit(ctx);
    const backupDirs = Array.from(fs.files.keys()).filter((k) =>
      k.startsWith("/home/u/.ratel/backups/"),
    );
    expect(backupDirs.length).toBeGreaterThan(0);
  });

  it("falls into interactive mode when no field flags are supplied", async () => {
    const fs = new MemFs();
    seed(fs, { ev: { type: "stdio", command: "echo", description: "old" } });

    const promptScript: Array<unknown> = [
      "description", // pick description first
      "fresh",
      "done",
    ];
    let i = 0;
    const recorded: { kind: string; message: string; initialValue?: unknown }[] = [];
    const prompts: PromptAdapter = {
      ...silentPromptAdapter(),
      isCancel: (v) => v === CANCEL_SYMBOL,
      async select(opts) {
        recorded.push({ kind: "select", message: opts.message });
        return promptScript[i++] as never;
      },
      async text(opts) {
        recorded.push({ kind: "text", message: opts.message, initialValue: opts.initialValue });
        return promptScript[i++] as string;
      },
    };

    const ctx = makeCtx(fs, {
      flags: { scope: "user", name: "ev" },
      prompts,
    });
    await runEdit(ctx);

    expect(read(fs).mcpServers.ev.description).toBe("fresh");
    const textPrompt = recorded.find((r) => r.kind === "text");
    expect(textPrompt?.initialValue).toBe("old");
  });
});
