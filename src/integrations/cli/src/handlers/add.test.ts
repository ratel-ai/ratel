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

function makeCtx(
  fs: MemFs,
  args: {
    flags?: ParsedArgs["flags"];
    rest?: string[];
    extras?: string[];
    env?: HierarchyEnv;
    log?: (m: string) => void;
  },
): HandlerCtx {
  return {
    argv: {
      group: "mcp",
      verb: "add",
      configPaths: [],
      rest: args.rest ?? [],
      extras: args.extras ?? [],
      flags: args.flags ?? {},
    },
    env: args.env ?? { homeDir: HOME, projectRoot: ROOT },
    fs,
    log: args.log ?? (() => {}),
    prompts: silentPromptAdapter(),
  };
}

const RATEL_USER_PATH = "/home/u/.ratel/config.json";

describe("runAdd — stdio (-- separator)", () => {
  it("creates a stdio entry from <name> + -- + command + args", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "user" },
      rest: ["fs"],
      extras: ["npx", "-y", "@x/y"],
    });
    await runAdd(ctx, { probe: async () => undefined });
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.fs).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@x/y"],
    });
  });

  it("creates a stdio entry with no args when only the command is given", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "user" },
      rest: ["fs"],
      extras: ["echo"],
    });
    await runAdd(ctx, { probe: async () => undefined });
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.fs).toEqual({ type: "stdio", command: "echo" });
  });

  it("threads --env and -e values into entry.env (KEY=VALUE pairs)", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "user", env: ["API_KEY=abc", "REGION=us-east-1"] },
      rest: ["stripe"],
      extras: ["npx", "-y", "@stripe/mcp"],
    });
    await runAdd(ctx, { probe: async () => undefined });
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.stripe.env).toEqual({
      API_KEY: "abc",
      REGION: "us-east-1",
    });
  });

  it("threads a single --env value (not an array) into entry.env", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "user", env: "ONLY=one" },
      rest: ["stripe"],
      extras: ["npx", "@stripe/mcp"],
    });
    await runAdd(ctx, { probe: async () => undefined });
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.stripe.env).toEqual({ ONLY: "one" });
  });

  it("rejects an --env value missing the `=` separator", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "user", env: "broken-no-equals" },
      rest: ["stripe"],
      extras: ["npx"],
    });
    await expect(runAdd(ctx, { probe: async () => undefined })).rejects.toThrow(/KEY=VALUE/);
  });
});

describe("runAdd — http/sse (positional URL)", () => {
  it("creates an http entry from <name> + <url> with --transport http", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "user", transport: "http" },
      rest: ["stripe", "https://mcp.stripe.com"],
    });
    await runAdd(ctx, { probe: async () => undefined });
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.stripe).toEqual({
      type: "http",
      url: "https://mcp.stripe.com",
    });
  });

  it("infers http transport when only a URL is given (no -- separator)", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "user" },
      rest: ["stripe", "https://mcp.stripe.com"],
    });
    await runAdd(ctx, { probe: async () => undefined });
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.stripe.type).toBe("http");
  });

  it("respects --transport sse for a URL positional", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "user", transport: "sse" },
      rest: ["stripe", "https://example.com/sse"],
    });
    await runAdd(ctx, { probe: async () => undefined });
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.stripe.type).toBe("sse");
  });

  it("threads --header values into entry.headers (parses `Name: Value` form)", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: {
        scope: "user",
        transport: "http",
        header: ["Authorization: Bearer x", "X-Trace: 42"],
      },
      rest: ["stripe", "https://mcp.stripe.com"],
    });
    await runAdd(ctx, { probe: async () => undefined });
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.stripe.headers).toEqual({
      Authorization: "Bearer x",
      "X-Trace": "42",
    });
  });

  it("rejects a --header value without `:` separator", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "user", transport: "http", header: "no-colon-here" },
      rest: ["stripe", "https://mcp.stripe.com"],
    });
    await expect(runAdd(ctx, { probe: async () => undefined })).rejects.toThrow(/Name: Value/);
  });
});

describe("runAdd — flags and overrides", () => {
  it("attaches --description to the entry alongside the inferred type", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "user", description: "echo for tests" },
      rest: ["fs"],
      extras: ["echo"],
    });
    await runAdd(ctx, { probe: async () => undefined });
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.fs.description).toBe("echo for tests");
  });

  it("omits description when --description is not provided", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "user" },
      rest: ["fs"],
      extras: ["echo"],
    });
    await runAdd(ctx, { probe: async () => undefined });
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.fs.description).toBeUndefined();
  });

  it("warns once when OAuth flags are set (deferred until v0.1.4)", async () => {
    const fs = new MemFs();
    const logs: string[] = [];
    const ctx = makeCtx(fs, {
      flags: {
        scope: "user",
        transport: "http",
        "client-id": "abc",
      },
      rest: ["stripe", "https://mcp.stripe.com"],
      log: (m) => logs.push(m),
    });
    await runAdd(ctx, { probe: async () => undefined });
    expect(logs.some((l) => /not yet wired/i.test(l))).toBe(true);
  });

  it("refuses to overwrite an existing entry without --force", async () => {
    const fs = new MemFs();
    fs.files.set(
      RATEL_USER_PATH,
      `${JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "old" } } })}\n`,
    );
    const ctx = makeCtx(fs, {
      flags: { scope: "user" },
      rest: ["fs"],
      extras: ["new"],
    });
    await expect(runAdd(ctx, { probe: async () => undefined })).rejects.toThrow(/already exists/);
  });

  it("overwrites an existing entry with --force", async () => {
    const fs = new MemFs();
    fs.files.set(
      RATEL_USER_PATH,
      `${JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "old" } } })}\n`,
    );
    const ctx = makeCtx(fs, {
      flags: { scope: "user", force: true },
      rest: ["fs"],
      extras: ["new"],
    });
    await runAdd(ctx, { probe: async () => undefined });
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.fs.command).toBe("new");
  });

  it("captures a backup before writing", async () => {
    const fs = new MemFs();
    fs.files.set(RATEL_USER_PATH, `${JSON.stringify({ mcpServers: {} })}\n`);
    const ctx = makeCtx(fs, {
      flags: { scope: "user" },
      rest: ["fs"],
      extras: ["echo"],
    });
    await runAdd(ctx, { probe: async () => undefined });
    const backupDirs = Array.from(fs.files.keys()).filter((k) =>
      k.startsWith("/home/u/.ratel/backups/"),
    );
    expect(backupDirs.length).toBeGreaterThan(0);
  });
});

describe("runAdd — error paths", () => {
  it("errors when --scope is missing", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, { rest: ["fs"], extras: ["echo"] });
    await expect(runAdd(ctx, { probe: async () => undefined })).rejects.toThrow(/--scope/);
  });

  it("errors when no name positional is provided", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, { flags: { scope: "user" }, extras: ["echo"] });
    await expect(runAdd(ctx, { probe: async () => undefined })).rejects.toThrow(/name/);
  });

  it("errors when no command (extras) and no URL (second positional) is provided", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, { flags: { scope: "user" }, rest: ["fs"] });
    await expect(runAdd(ctx, { probe: async () => undefined })).rejects.toThrow(/command|url/i);
  });

  it("errors when project scope requested without a project root", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "project" },
      rest: ["fs"],
      extras: ["echo"],
      env: { homeDir: HOME },
    });
    await expect(runAdd(ctx, { probe: async () => undefined })).rejects.toThrow();
  });

  it("rejects --scope global with a hint to use --scope user", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "global" },
      rest: ["fs"],
      extras: ["echo"],
    });
    await expect(runAdd(ctx, { probe: async () => undefined })).rejects.toThrow(/user/);
  });
});

describe("runAdd — fetch-description default", () => {
  it("by default probes the upstream and stores the returned instructions as description", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "user" },
      rest: ["stripe", "https://mcp.stripe.com"],
    });
    const calls: Array<{ name: string; type: string }> = [];
    await runAdd(ctx, {
      probe: async (name, entry) => {
        calls.push({ name, type: entry.type ?? "stdio" });
        return "stripe upstream instructions";
      },
    });
    expect(calls).toEqual([{ name: "stripe", type: "http" }]);
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.stripe.description).toBe("stripe upstream instructions");
  });

  it("does not call the probe when --description is explicitly set", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "user", description: "explicit" },
      rest: ["fs"],
      extras: ["echo"],
    });
    let probeCalled = false;
    await runAdd(ctx, {
      probe: async () => {
        probeCalled = true;
        return "from upstream";
      },
    });
    expect(probeCalled).toBe(false);
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.fs.description).toBe("explicit");
  });

  it("--no-fetch-description skips probing entirely", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "user", "fetch-description": false },
      rest: ["fs"],
      extras: ["echo"],
    });
    let probeCalled = false;
    await runAdd(ctx, {
      probe: async () => {
        probeCalled = true;
        return "from upstream";
      },
    });
    expect(probeCalled).toBe(false);
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.fs.description).toBeUndefined();
  });

  it("leaves description undefined when the probe returns undefined", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "user" },
      rest: ["fs"],
      extras: ["echo"],
    });
    await runAdd(ctx, { probe: async () => undefined });
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.fs.description).toBeUndefined();
  });

  it("swallows a thrown probe (does not fail the add)", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "user" },
      rest: ["fs"],
      extras: ["echo"],
    });
    await runAdd(ctx, {
      probe: async () => {
        throw new Error("boom");
      },
    });
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.fs).toEqual({ type: "stdio", command: "echo" });
  });
});
