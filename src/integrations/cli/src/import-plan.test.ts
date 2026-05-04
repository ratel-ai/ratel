import type { ServerEntry } from "@ratel-ai/mcp-server";
import { describe, expect, it } from "vitest";
import type { ClaudeConfigDoc } from "./claude.js";
import { buildImportPlan, type ImportInputs } from "./import-plan.js";
import type { ResolvedBin } from "./locate-bin.js";

const HOME_CLAUDE = "/home/u/.claude.json";
const PROJECT_MCP = "/r/.mcp.json";
const RATEL_USER = "/home/u/.ratel/config.json";
const RATEL_PROJECT = "/r/.ratel/config.json";
const RATEL_LOCAL = "/r/.ratel/config.local.json";

const BIN: ResolvedBin = {
  command: "ratel",
  args: [],
  source: "path",
};

function claudeDoc(
  scope: "user" | "project" | "local",
  mcpServers: Record<string, ServerEntry>,
  rawExtra: Record<string, unknown> = {},
): ClaudeConfigDoc {
  const path = scope === "project" ? PROJECT_MCP : HOME_CLAUDE;
  let raw: Record<string, unknown>;
  if (scope === "local") {
    raw = { ...rawExtra, projects: { "/r": { mcpServers } } };
  } else {
    raw = { ...rawExtra, mcpServers };
  }
  return { scope, path, raw, mcpServers };
}

function emptyInputs(overrides: Partial<ImportInputs> = {}): ImportInputs {
  return {
    claudeUser: null,
    claudeProject: null,
    claudeLocal: null,
    ratelUser: null,
    ratelProject: null,
    ratelLocal: null,
    bin: BIN,
    ratelUserPath: RATEL_USER,
    ratelProjectPath: RATEL_PROJECT,
    ratelLocalPath: RATEL_LOCAL,
    ...overrides,
  };
}

const FS_ENTRY: ServerEntry = { type: "stdio", command: "echo", args: ["fs"] };
const REMOTE_ENTRY: ServerEntry = { type: "http", url: "https://r" };
const PROJ_ENTRY: ServerEntry = { type: "stdio", command: "echo", args: ["proj"] };
const LOCAL_ENTRY: ServerEntry = { type: "stdio", command: "echo", args: ["local"] };

function allChanges(plan: ReturnType<typeof buildImportPlan>) {
  return [...plan.ratelChanges, ...plan.claudeChanges];
}

function findWrite(plan: ReturnType<typeof buildImportPlan>, path: string) {
  return allChanges(plan).find((c) => c.kind === "write" && c.path === path);
}

function parseAfter(plan: ReturnType<typeof buildImportPlan>, path: string) {
  const c = findWrite(plan, path);
  if (!c || c.kind !== "write") throw new Error(`no write to ${path}`);
  return JSON.parse(c.after);
}

describe("buildImportPlan", () => {
  it("global-only: moves entries into Ratel global, writes ratel entry into Claude global with [global] arg chain", () => {
    const plan = buildImportPlan(
      emptyInputs({
        claudeUser: claudeDoc("user", { fs: FS_ENTRY, remote: REMOTE_ENTRY }),
      }),
    );

    expect(plan.summary.movedFromUser.sort()).toEqual(["fs", "remote"]);
    expect(plan.summary.ratelEntryArgsByScope.user).toEqual(["--config", RATEL_USER]);
    expect(plan.summary.ratelEntryArgsByScope.project).toBeUndefined();
    expect(plan.summary.ratelEntryArgsByScope.local).toBeUndefined();

    const ratelUser = parseAfter(plan, RATEL_USER);
    expect(ratelUser.mcpServers.fs).toEqual(FS_ENTRY);
    expect(ratelUser.mcpServers.remote).toEqual(REMOTE_ENTRY);

    const claudeUser = parseAfter(plan, HOME_CLAUDE);
    expect(claudeUser.mcpServers).toEqual({
      ratel: {
        type: "stdio",
        command: "ratel",
        args: ["mcp", "serve", "--config", RATEL_USER],
      },
    });
  });

  it("global+project: project Claude entry args list global then project", () => {
    const plan = buildImportPlan(
      emptyInputs({
        claudeUser: claudeDoc("user", { fs: FS_ENTRY }),
        claudeProject: claudeDoc("project", { proj: PROJ_ENTRY }),
      }),
    );

    expect(plan.summary.ratelEntryArgsByScope.project).toEqual([
      "--config",
      RATEL_USER,
      "--config",
      RATEL_PROJECT,
    ]);
    const claudeProject = parseAfter(plan, PROJECT_MCP);
    expect(claudeProject.mcpServers.ratel.args).toEqual([
      "mcp",
      "serve",
      "--config",
      RATEL_USER,
      "--config",
      RATEL_PROJECT,
    ]);
  });

  it("global+project+local: local Claude entry args list all three; ~/.claude.json is one merged write", () => {
    const plan = buildImportPlan(
      emptyInputs({
        claudeUser: claudeDoc("user", { fs: FS_ENTRY }),
        claudeProject: claudeDoc("project", { proj: PROJ_ENTRY }),
        claudeLocal: claudeDoc("local", { local: LOCAL_ENTRY }),
      }),
    );

    expect(plan.summary.ratelEntryArgsByScope.local).toEqual([
      "--config",
      RATEL_USER,
      "--config",
      RATEL_PROJECT,
      "--config",
      RATEL_LOCAL,
    ]);

    const homeWrites = allChanges(plan).filter((c) => c.kind === "write" && c.path === HOME_CLAUDE);
    expect(homeWrites).toHaveLength(1);

    const merged = parseAfter(plan, HOME_CLAUDE);
    expect(merged.mcpServers.ratel.args).toEqual(["mcp", "serve", "--config", RATEL_USER]);
    expect(merged.projects["/r"].mcpServers.ratel.args).toEqual([
      "mcp",
      "serve",
      "--config",
      RATEL_USER,
      "--config",
      RATEL_PROJECT,
      "--config",
      RATEL_LOCAL,
    ]);
  });

  it("local-only: writes only the local Ratel target; ratel entry args still list all three configs", () => {
    const plan = buildImportPlan(
      emptyInputs({
        claudeLocal: claudeDoc("local", { local: LOCAL_ENTRY }),
      }),
    );

    expect(plan.summary.ratelEntryArgsByScope.local).toEqual([
      "--config",
      RATEL_USER,
      "--config",
      RATEL_PROJECT,
      "--config",
      RATEL_LOCAL,
    ]);
    expect(findWrite(plan, RATEL_USER)).toBeUndefined();
    expect(findWrite(plan, RATEL_PROJECT)).toBeUndefined();
    expect(findWrite(plan, RATEL_LOCAL)).toBeDefined();
  });

  it("preserves all non-mcp keys in ~/.claude.json, including untouched projects[<other-root>]", () => {
    const claudeUser = claudeDoc(
      "user",
      { fs: FS_ENTRY },
      {
        version: 7,
        otherSetting: { nested: true },
        projects: { "/elsewhere": { mcpServers: { keep: { command: "x" } } } },
      },
    );
    const plan = buildImportPlan(emptyInputs({ claudeUser }));

    const after = parseAfter(plan, HOME_CLAUDE);
    expect(after.version).toBe(7);
    expect(after.otherSetting).toEqual({ nested: true });
    expect(after.projects["/elsewhere"]).toEqual({
      mcpServers: { keep: { command: "x" } },
    });
  });

  it("skips entries literally named ratel at every scope (idempotency)", () => {
    const ratelStub: ServerEntry = {
      type: "stdio",
      command: "ratel",
      args: ["mcp", "serve", "--config", RATEL_USER],
    };
    const plan = buildImportPlan(
      emptyInputs({
        claudeUser: claudeDoc("user", { ratel: ratelStub }),
        claudeProject: claudeDoc("project", { ratel: ratelStub }),
        claudeLocal: claudeDoc("local", { ratel: ratelStub }),
      }),
    );

    expect(plan.summary.movedFromUser).toEqual([]);
    expect(plan.summary.movedFromProject).toEqual([]);
    expect(plan.summary.movedFromLocal).toEqual([]);
    expect(findWrite(plan, RATEL_USER)).toBeUndefined();
  });

  it("logs collisions when an entry exists both in Claude and the existing Ratel target (Ratel wins)", () => {
    const existingRatelEntry: ServerEntry = { type: "stdio", command: "kept" };
    const plan = buildImportPlan(
      emptyInputs({
        claudeUser: claudeDoc("user", { fs: FS_ENTRY, other: REMOTE_ENTRY }),
        ratelUser: { mcpServers: { fs: existingRatelEntry } },
      }),
    );

    const ratelUser = parseAfter(plan, RATEL_USER);
    expect(ratelUser.mcpServers.fs).toEqual(existingRatelEntry);
    expect(ratelUser.mcpServers.other).toEqual(REMOTE_ENTRY);
    expect(plan.summary.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "fs", scope: "user" })]),
    );
  });

  it("does not emit a ratel entry into a Claude scope that had no MCPs", () => {
    const plan = buildImportPlan(
      emptyInputs({
        claudeUser: claudeDoc("user", { fs: FS_ENTRY }),
        claudeProject: claudeDoc("project", {}),
      }),
    );

    expect(plan.summary.ratelEntryArgsByScope.user).toBeDefined();
    expect(plan.summary.ratelEntryArgsByScope.project).toBeUndefined();
    expect(findWrite(plan, PROJECT_MCP)).toBeUndefined();
  });

  it("drops project- and local-scope writes when no project root is configured", () => {
    const plan = buildImportPlan(
      emptyInputs({
        claudeUser: claudeDoc("user", { fs: FS_ENTRY }),
        ratelProjectPath: undefined,
        ratelLocalPath: undefined,
      }),
    );
    expect(findWrite(plan, RATEL_USER)).toBeDefined();
    expect(findWrite(plan, RATEL_PROJECT)).toBeUndefined();
    expect(findWrite(plan, RATEL_LOCAL)).toBeUndefined();
  });

  it("preserves unknown transport types verbatim into the Ratel target", () => {
    const weird: ServerEntry = { type: "websocket", url: "ws://x", custom: true };
    const plan = buildImportPlan(
      emptyInputs({
        claudeUser: claudeDoc("user", { weird }),
      }),
    );
    const after = parseAfter(plan, RATEL_USER);
    expect(after.mcpServers.weird).toEqual(weird);
  });

  it("dedups across scopes: most-specific wins, drops at higher scopes are logged", () => {
    const plan = buildImportPlan(
      emptyInputs({
        claudeUser: claudeDoc("user", { fs: FS_ENTRY }),
        claudeProject: claudeDoc("project", { fs: PROJ_ENTRY }),
      }),
    );
    const ratelProject = parseAfter(plan, RATEL_PROJECT);
    expect(ratelProject.mcpServers.fs).toEqual(PROJ_ENTRY);
    expect(findWrite(plan, RATEL_USER)).toBeUndefined(); // global "fs" was dropped
    expect(plan.summary.movedFromProject).toEqual(["fs"]);
    expect(plan.summary.movedFromUser).toEqual([]);
    expect(plan.summary.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "fs", scope: "user" })]),
    );
  });

  it("merges new Claude entries with existing Ratel entries when names don't collide", () => {
    const plan = buildImportPlan(
      emptyInputs({
        claudeUser: claudeDoc("user", { fs: FS_ENTRY }),
        ratelUser: { mcpServers: { existing: { type: "stdio", command: "keep" } } },
      }),
    );
    const ratelUser = parseAfter(plan, RATEL_USER);
    expect(ratelUser.mcpServers.fs).toEqual(FS_ENTRY);
    expect(ratelUser.mcpServers.existing).toEqual({ type: "stdio", command: "keep" });
  });

  it("returns an empty plan when there's nothing to move and no rewrites needed", () => {
    const plan = buildImportPlan(emptyInputs({ claudeUser: claudeDoc("user", {}) }));
    expect(plan.ratelChanges).toEqual([]);
    expect(plan.claudeChanges).toEqual([]);
  });

  it("partitions writes: Ratel scope configs in ratelChanges, Claude config rewrites in claudeChanges", () => {
    const plan = buildImportPlan(
      emptyInputs({
        claudeUser: claudeDoc("user", { fs: FS_ENTRY }),
        claudeProject: claudeDoc("project", { proj: PROJ_ENTRY }),
      }),
    );

    const ratelPaths = plan.ratelChanges.map((c) => c.path).sort();
    const claudePaths = plan.claudeChanges.map((c) => c.path).sort();
    expect(ratelPaths).toEqual([RATEL_USER, RATEL_PROJECT].sort());
    expect(claudePaths).toEqual([HOME_CLAUDE, PROJECT_MCP].sort());
  });

  it("filters movable entries by `selection` — non-selected names stay out of the plan entirely", () => {
    const plan = buildImportPlan(
      emptyInputs({
        claudeUser: claudeDoc("user", { fs: FS_ENTRY, remote: REMOTE_ENTRY }),
      }),
      { selection: new Set(["fs"]) },
    );

    const ratelUser = parseAfter(plan, RATEL_USER);
    expect(ratelUser.mcpServers.fs).toEqual(FS_ENTRY);
    expect(ratelUser.mcpServers.remote).toBeUndefined();
    expect(plan.summary.movedFromUser).toEqual(["fs"]);
  });

  it("when `selection` excludes every entry at a Claude scope, no Claude rewrite is emitted for that scope", () => {
    const plan = buildImportPlan(
      emptyInputs({
        claudeUser: claudeDoc("user", { fs: FS_ENTRY }),
        claudeProject: claudeDoc("project", { proj: PROJ_ENTRY }),
      }),
      { selection: new Set(["fs"]) }, // proj deselected
    );

    expect(findWrite(plan, RATEL_PROJECT)).toBeUndefined();
    expect(findWrite(plan, PROJECT_MCP)).toBeUndefined();
    expect(plan.claudeChanges.find((c) => c.path === HOME_CLAUDE)).toBeDefined();
  });
});
