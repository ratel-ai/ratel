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
    await runAdd(ctx, {
      probe: async () => undefined,
      authProbe: async () => ({ status: "skipped", reason: "test" }),
    });
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
    await runAdd(ctx, {
      probe: async () => undefined,
      authProbe: async () => ({ status: "skipped", reason: "test" }),
    });
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.stripe.type).toBe("http");
  });

  it("respects --transport sse for a URL positional", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "user", transport: "sse" },
      rest: ["stripe", "https://example.com/sse"],
    });
    await runAdd(ctx, {
      probe: async () => undefined,
      authProbe: async () => ({ status: "skipped", reason: "test" }),
    });
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
    await runAdd(ctx, {
      probe: async () => undefined,
      authProbe: async () => ({ status: "skipped", reason: "test" }),
    });
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

  it("persists --client-id, --callback-port, and --scope onto an http entry", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: {
        scope: "user",
        transport: "http",
        "client-id": "static-abc",
        "callback-port": "37123",
        "oauth-scope": "read:tools write:tools",
      },
      rest: ["stripe", "https://mcp.stripe.com"],
    });
    await runAdd(ctx, {
      probe: async () => undefined,
      authProbe: async () => ({ status: "skipped", reason: "test" }),
    });
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.stripe).toMatchObject({
      type: "http",
      url: "https://mcp.stripe.com",
      clientId: "static-abc",
      callbackPort: 37123,
      scope: "read:tools write:tools",
    });
  });

  it("persists --client-secret but warns about plaintext storage", async () => {
    const fs = new MemFs();
    const logs: string[] = [];
    const ctx = makeCtx(fs, {
      flags: {
        scope: "user",
        transport: "http",
        "client-id": "abc",
        "client-secret": "shhh",
      },
      rest: ["stripe", "https://mcp.stripe.com"],
      log: (m) => logs.push(m),
    });
    await runAdd(ctx, {
      probe: async () => undefined,
      authProbe: async () => ({ status: "skipped", reason: "test" }),
    });
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.stripe.clientSecret).toBe("shhh");
    expect(logs.some((l) => /plaintext|client.secret/i.test(l))).toBe(true);
  });

  it("rejects OAuth flags on a stdio entry", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "user", "client-id": "abc" },
      rest: ["fs"],
      extras: ["npx"],
    });
    await expect(runAdd(ctx, { probe: async () => undefined })).rejects.toThrow(/stdio|http\/sse/i);
  });

  it("rejects a non-numeric --callback-port", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "user", transport: "http", "callback-port": "not-a-number" },
      rest: ["stripe", "https://mcp.stripe.com"],
    });
    await expect(runAdd(ctx, { probe: async () => undefined })).rejects.toThrow(/callback-port/i);
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
  it("defaults to --scope user when omitted", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, { rest: ["fs"], extras: ["echo"] });
    await runAdd(ctx, { probe: async () => undefined });
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.fs).toEqual({ type: "stdio", command: "echo" });
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

describe("runAdd — fetch-description default (stdio)", () => {
  it("by default probes the upstream and stores the returned instructions as description", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "user" },
      rest: ["fs"],
      extras: ["echo"],
    });
    const calls: Array<{ name: string; type: string }> = [];
    await runAdd(ctx, {
      probe: async (name, entry) => {
        calls.push({ name, type: entry.type ?? "stdio" });
        return "echo upstream instructions";
      },
    });
    expect(calls).toEqual([{ name: "fs", type: "stdio" }]);
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.fs.description).toBe("echo upstream instructions");
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

describe("runAdd — auth-probe at add-time (http/sse)", () => {
  it("calls authProbe (not the silent probe) for an http entry and stores returned instructions", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "user" },
      rest: ["stripe", "https://mcp.stripe.com"],
    });
    const probeCalls: string[] = [];
    const authCalls: Array<{ name: string; type: string }> = [];
    await runAdd(ctx, {
      probe: async (name) => {
        probeCalls.push(name);
        return undefined;
      },
      authProbe: async (name, entry) => {
        authCalls.push({ name, type: entry.type ?? "stdio" });
        return { status: "authorized", instructions: "stripe instructions" };
      },
    });
    expect(probeCalls).toEqual([]);
    expect(authCalls).toEqual([{ name: "stripe", type: "http" }]);
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.stripe.description).toBe("stripe instructions");
  });

  it("calls authProbe for an sse entry too", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "user", transport: "sse" },
      rest: ["stripe", "https://example.com/sse"],
    });
    const calls: Array<{ name: string; type: string }> = [];
    await runAdd(ctx, {
      probe: async () => undefined,
      authProbe: async (name, entry) => {
        calls.push({ name, type: entry.type ?? "stdio" });
        return { status: "authorized", instructions: "sse instructions" };
      },
    });
    expect(calls).toEqual([{ name: "stripe", type: "sse" }]);
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.stripe.description).toBe("sse instructions");
  });

  it("still triggers authProbe when --description is explicit (so tokens get persisted), but user's text wins", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "user", description: "user-supplied" },
      rest: ["stripe", "https://mcp.stripe.com"],
    });
    let authCalled = false;
    await runAdd(ctx, {
      probe: async () => undefined,
      authProbe: async () => {
        authCalled = true;
        return { status: "authorized", instructions: "from upstream" };
      },
    });
    expect(authCalled).toBe(true);
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.stripe.description).toBe("user-supplied");
  });

  it("logs a warning + hint and persists the entry without description when authProbe returns failed", async () => {
    const fs = new MemFs();
    const logs: string[] = [];
    const ctx = makeCtx(fs, {
      flags: { scope: "user" },
      rest: ["stripe", "https://mcp.stripe.com"],
      log: (m) => logs.push(m),
    });
    await runAdd(ctx, {
      probe: async () => undefined,
      authProbe: async () => ({ status: "failed", reason: "user denied" }),
    });
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.stripe.description).toBeUndefined();
    const all = logs.join("\n");
    expect(all).toMatch(/stripe/);
    expect(all).toMatch(/user denied/);
    expect(all).toMatch(/ratel mcp auth/);
  });

  it("--no-fetch-description skips authProbe too", async () => {
    const fs = new MemFs();
    const ctx = makeCtx(fs, {
      flags: { scope: "user", "fetch-description": false },
      rest: ["stripe", "https://mcp.stripe.com"],
    });
    let authCalled = false;
    let probeCalled = false;
    await runAdd(ctx, {
      probe: async () => {
        probeCalled = true;
        return undefined;
      },
      authProbe: async () => {
        authCalled = true;
        return { status: "authorized" };
      },
    });
    expect(authCalled).toBe(false);
    expect(probeCalled).toBe(false);
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.stripe.description).toBeUndefined();
  });

  it("does not throw when authProbe itself throws (degrades to a logged warning)", async () => {
    const fs = new MemFs();
    const logs: string[] = [];
    const ctx = makeCtx(fs, {
      flags: { scope: "user" },
      rest: ["stripe", "https://mcp.stripe.com"],
      log: (m) => logs.push(m),
    });
    await runAdd(ctx, {
      probe: async () => undefined,
      authProbe: async () => {
        throw new Error("network down");
      },
    });
    const parsed = JSON.parse(fs.files.get(RATEL_USER_PATH) as string);
    expect(parsed.mcpServers.stripe.url).toBe("https://mcp.stripe.com");
    expect(logs.join("\n")).toMatch(/network down|stripe/);
  });
});

describe("runAdd — recap output after writing", () => {
  it("logs the type, command, args, env keys, and the chosen description for a stdio entry", async () => {
    const fs = new MemFs();
    const logs: string[] = [];
    const ctx = makeCtx(fs, {
      flags: { scope: "user", env: ["A=1", "B=2"] },
      rest: ["fs"],
      extras: ["echo", "hi"],
      log: (m) => logs.push(m),
    });
    await runAdd(ctx, { probe: async () => "echo says hello" });
    const all = logs.join("\n");
    expect(all).toMatch(/type:.*stdio/);
    expect(all).toMatch(/command:.*echo hi/);
    expect(all).toMatch(/env:.*A.*B/);
    expect(all).toMatch(/description:.*echo says hello/);
    expect(all).toMatch(/ratel mcp edit --scope user --name fs/);
  });

  it("logs the url, header keys, oauth fields, and description for an http entry (never echoes the client-secret value)", async () => {
    const fs = new MemFs();
    const logs: string[] = [];
    const ctx = makeCtx(fs, {
      flags: {
        scope: "user",
        transport: "http",
        header: "Authorization: Bearer xyz",
        "client-id": "cid",
        "client-secret": "shhh",
        "callback-port": "37123",
      },
      rest: ["stripe", "https://mcp.stripe.com"],
      log: (m) => logs.push(m),
    });
    await runAdd(ctx, {
      probe: async () => undefined,
      authProbe: async () => ({ status: "authorized", instructions: "stripe upstream" }),
    });
    const all = logs.join("\n");
    expect(all).toMatch(/url:.*https:\/\/mcp\.stripe\.com/);
    expect(all).toMatch(/headers:.*Authorization/);
    expect(all).not.toMatch(/Bearer xyz/);
    expect(all).toMatch(/client-id:.*cid/);
    expect(all).toMatch(/callback-port:.*37123/);
    expect(all).not.toMatch(/shhh/);
    expect(all).toMatch(/client-secret:.*\(hidden\)/);
    expect(all).toMatch(/description:.*stripe upstream/);
    expect(all).toMatch(/ratel mcp edit --scope user --name stripe/);
  });

  it("trims a description preview at the first newline (with ellipsis)", async () => {
    const fs = new MemFs();
    const logs: string[] = [];
    const ctx = makeCtx(fs, {
      flags: { scope: "user" },
      rest: ["fs"],
      extras: ["echo"],
      log: (m) => logs.push(m),
    });
    await runAdd(ctx, { probe: async () => "first line\nsecond line\nmore" });
    const all = logs.join("\n");
    expect(all).toMatch(/description:.*first line…/);
    expect(all).not.toMatch(/second line/);
  });

  it("trims a long single-line description preview at 120 chars (with ellipsis)", async () => {
    const fs = new MemFs();
    const logs: string[] = [];
    const long = "a".repeat(150);
    const ctx = makeCtx(fs, {
      flags: { scope: "user" },
      rest: ["fs"],
      extras: ["echo"],
      log: (m) => logs.push(m),
    });
    await runAdd(ctx, { probe: async () => long });
    const all = logs.join("\n");
    const desc = all.split("\n").find((l) => /description:/.test(l)) ?? "";
    expect(desc).toMatch(/a{120}…/);
    expect(desc).not.toMatch(/a{121}/);
  });

  it("does not show a description line when none was set or fetched", async () => {
    const fs = new MemFs();
    const logs: string[] = [];
    const ctx = makeCtx(fs, {
      flags: { scope: "user" },
      rest: ["fs"],
      extras: ["echo"],
      log: (m) => logs.push(m),
    });
    await runAdd(ctx, { probe: async () => undefined });
    const all = logs.join("\n");
    expect(all).not.toMatch(/description:/);
    expect(all).toMatch(/ratel mcp edit --scope user --name fs/);
  });
});
