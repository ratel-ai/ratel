import { describe, expect, it } from "vitest";
import type { ClaudeConfigDoc } from "./claude.js";
import type { ServerEntry } from "./config.js";
import { buildImportPlan, type ImportInputs } from "./import-plan.js";
import type { ResolvedBin } from "./locate-bin.js";

const HOME_CLAUDE = "/home/u/.claude.json";
const PROJECT_MCP = "/r/.mcp.json";
const RATEL_GLOBAL = "/home/u/.ratel/config.json";
const RATEL_PROJECT = "/r/.ratel/config.json";
const RATEL_LOCAL = "/r/.ratel/config.local.json";

const BIN: ResolvedBin = {
  command: "ratel-mcp-server",
  args: [],
  source: "path",
};

function claudeDoc(
  scope: "global" | "project" | "local",
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
    claudeGlobal: null,
    claudeProject: null,
    claudeLocal: null,
    ratelGlobal: null,
    ratelProject: null,
    ratelLocal: null,
    bin: BIN,
    ratelGlobalPath: RATEL_GLOBAL,
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
        claudeGlobal: claudeDoc("global", { fs: FS_ENTRY, remote: REMOTE_ENTRY }),
      }),
    );

    expect(plan.summary.movedFromGlobal.sort()).toEqual(["fs", "remote"]);
    expect(plan.summary.ratelEntryArgsByScope.global).toEqual(["--config", RATEL_GLOBAL]);
    expect(plan.summary.ratelEntryArgsByScope.project).toBeUndefined();
    expect(plan.summary.ratelEntryArgsByScope.local).toBeUndefined();

    const ratelGlobal = parseAfter(plan, RATEL_GLOBAL);
    expect(ratelGlobal.mcpServers.fs).toEqual(FS_ENTRY);
    expect(ratelGlobal.mcpServers.remote).toEqual(REMOTE_ENTRY);

    const claudeGlobal = parseAfter(plan, HOME_CLAUDE);
    expect(claudeGlobal.mcpServers).toEqual({
      ratel: { type: "stdio", command: "ratel-mcp-server", args: ["--config", RATEL_GLOBAL] },
    });
  });

  it("global+project: project Claude entry args list global then project", () => {
    const plan = buildImportPlan(
      emptyInputs({
        claudeGlobal: claudeDoc("global", { fs: FS_ENTRY }),
        claudeProject: claudeDoc("project", { proj: PROJ_ENTRY }),
      }),
    );

    expect(plan.summary.ratelEntryArgsByScope.project).toEqual([
      "--config",
      RATEL_GLOBAL,
      "--config",
      RATEL_PROJECT,
    ]);
    const claudeProject = parseAfter(plan, PROJECT_MCP);
    expect(claudeProject.mcpServers.ratel.args).toEqual([
      "--config",
      RATEL_GLOBAL,
      "--config",
      RATEL_PROJECT,
    ]);
  });

  it("global+project+local: local Claude entry args list all three; ~/.claude.json is one merged write", () => {
    const plan = buildImportPlan(
      emptyInputs({
        claudeGlobal: claudeDoc("global", { fs: FS_ENTRY }),
        claudeProject: claudeDoc("project", { proj: PROJ_ENTRY }),
        claudeLocal: claudeDoc("local", { local: LOCAL_ENTRY }),
      }),
    );

    expect(plan.summary.ratelEntryArgsByScope.local).toEqual([
      "--config",
      RATEL_GLOBAL,
      "--config",
      RATEL_PROJECT,
      "--config",
      RATEL_LOCAL,
    ]);

    const homeWrites = allChanges(plan).filter((c) => c.kind === "write" && c.path === HOME_CLAUDE);
    expect(homeWrites).toHaveLength(1);

    const merged = parseAfter(plan, HOME_CLAUDE);
    expect(merged.mcpServers.ratel.args).toEqual(["--config", RATEL_GLOBAL]);
    expect(merged.projects["/r"].mcpServers.ratel.args).toEqual([
      "--config",
      RATEL_GLOBAL,
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
      RATEL_GLOBAL,
      "--config",
      RATEL_PROJECT,
      "--config",
      RATEL_LOCAL,
    ]);
    expect(findWrite(plan, RATEL_GLOBAL)).toBeUndefined();
    expect(findWrite(plan, RATEL_PROJECT)).toBeUndefined();
    expect(findWrite(plan, RATEL_LOCAL)).toBeDefined();
  });

  it("preserves all non-mcp keys in ~/.claude.json, including untouched projects[<other-root>]", () => {
    const claudeGlobal = claudeDoc(
      "global",
      { fs: FS_ENTRY },
      {
        version: 7,
        otherSetting: { nested: true },
        projects: { "/elsewhere": { mcpServers: { keep: { command: "x" } } } },
      },
    );
    const plan = buildImportPlan(emptyInputs({ claudeGlobal }));

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
      command: "ratel-mcp-server",
      args: ["--config", RATEL_GLOBAL],
    };
    const plan = buildImportPlan(
      emptyInputs({
        claudeGlobal: claudeDoc("global", { ratel: ratelStub }),
        claudeProject: claudeDoc("project", { ratel: ratelStub }),
        claudeLocal: claudeDoc("local", { ratel: ratelStub }),
      }),
    );

    expect(plan.summary.movedFromGlobal).toEqual([]);
    expect(plan.summary.movedFromProject).toEqual([]);
    expect(plan.summary.movedFromLocal).toEqual([]);
    expect(findWrite(plan, RATEL_GLOBAL)).toBeUndefined();
  });

  it("logs collisions when an entry exists both in Claude and the existing Ratel target (Ratel wins)", () => {
    const existingRatelEntry: ServerEntry = { type: "stdio", command: "kept" };
    const plan = buildImportPlan(
      emptyInputs({
        claudeGlobal: claudeDoc("global", { fs: FS_ENTRY, other: REMOTE_ENTRY }),
        ratelGlobal: { mcpServers: { fs: existingRatelEntry } },
      }),
    );

    const ratelGlobal = parseAfter(plan, RATEL_GLOBAL);
    expect(ratelGlobal.mcpServers.fs).toEqual(existingRatelEntry);
    expect(ratelGlobal.mcpServers.other).toEqual(REMOTE_ENTRY);
    expect(plan.summary.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "fs", scope: "global" })]),
    );
  });

  it("does not emit a ratel entry into a Claude scope that had no MCPs", () => {
    const plan = buildImportPlan(
      emptyInputs({
        claudeGlobal: claudeDoc("global", { fs: FS_ENTRY }),
        claudeProject: claudeDoc("project", {}),
      }),
    );

    expect(plan.summary.ratelEntryArgsByScope.global).toBeDefined();
    expect(plan.summary.ratelEntryArgsByScope.project).toBeUndefined();
    expect(findWrite(plan, PROJECT_MCP)).toBeUndefined();
  });

  it("drops project- and local-scope writes when no project root is configured", () => {
    const plan = buildImportPlan(
      emptyInputs({
        claudeGlobal: claudeDoc("global", { fs: FS_ENTRY }),
        ratelProjectPath: undefined,
        ratelLocalPath: undefined,
      }),
    );
    expect(findWrite(plan, RATEL_GLOBAL)).toBeDefined();
    expect(findWrite(plan, RATEL_PROJECT)).toBeUndefined();
    expect(findWrite(plan, RATEL_LOCAL)).toBeUndefined();
  });

  it("preserves unknown transport types verbatim into the Ratel target", () => {
    const weird: ServerEntry = { type: "websocket", url: "ws://x", custom: true };
    const plan = buildImportPlan(
      emptyInputs({
        claudeGlobal: claudeDoc("global", { weird }),
      }),
    );
    const after = parseAfter(plan, RATEL_GLOBAL);
    expect(after.mcpServers.weird).toEqual(weird);
  });

  it("dedups across scopes: most-specific wins, drops at higher scopes are logged", () => {
    const plan = buildImportPlan(
      emptyInputs({
        claudeGlobal: claudeDoc("global", { fs: FS_ENTRY }),
        claudeProject: claudeDoc("project", { fs: PROJ_ENTRY }),
      }),
    );
    const ratelProject = parseAfter(plan, RATEL_PROJECT);
    expect(ratelProject.mcpServers.fs).toEqual(PROJ_ENTRY);
    expect(findWrite(plan, RATEL_GLOBAL)).toBeUndefined(); // global "fs" was dropped
    expect(plan.summary.movedFromProject).toEqual(["fs"]);
    expect(plan.summary.movedFromGlobal).toEqual([]);
    expect(plan.summary.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "fs", scope: "global" })]),
    );
  });

  it("merges new Claude entries with existing Ratel entries when names don't collide", () => {
    const plan = buildImportPlan(
      emptyInputs({
        claudeGlobal: claudeDoc("global", { fs: FS_ENTRY }),
        ratelGlobal: { mcpServers: { existing: { type: "stdio", command: "keep" } } },
      }),
    );
    const ratelGlobal = parseAfter(plan, RATEL_GLOBAL);
    expect(ratelGlobal.mcpServers.fs).toEqual(FS_ENTRY);
    expect(ratelGlobal.mcpServers.existing).toEqual({ type: "stdio", command: "keep" });
  });

  it("returns an empty plan when there's nothing to move and no rewrites needed", () => {
    const plan = buildImportPlan(emptyInputs({ claudeGlobal: claudeDoc("global", {}) }));
    expect(plan.ratelChanges).toEqual([]);
    expect(plan.claudeChanges).toEqual([]);
  });

  it("partitions writes: Ratel scope configs in ratelChanges, Claude config rewrites in claudeChanges", () => {
    const plan = buildImportPlan(
      emptyInputs({
        claudeGlobal: claudeDoc("global", { fs: FS_ENTRY }),
        claudeProject: claudeDoc("project", { proj: PROJ_ENTRY }),
      }),
    );

    const ratelPaths = plan.ratelChanges.map((c) => c.path).sort();
    const claudePaths = plan.claudeChanges.map((c) => c.path).sort();
    expect(ratelPaths).toEqual([RATEL_GLOBAL, RATEL_PROJECT].sort());
    expect(claudePaths).toEqual([HOME_CLAUDE, PROJECT_MCP].sort());
  });

  it("filters movable entries by `selection` — non-selected names stay out of the plan entirely", () => {
    const plan = buildImportPlan(
      emptyInputs({
        claudeGlobal: claudeDoc("global", { fs: FS_ENTRY, remote: REMOTE_ENTRY }),
      }),
      { selection: new Set(["fs"]) },
    );

    const ratelGlobal = parseAfter(plan, RATEL_GLOBAL);
    expect(ratelGlobal.mcpServers.fs).toEqual(FS_ENTRY);
    expect(ratelGlobal.mcpServers.remote).toBeUndefined();
    expect(plan.summary.movedFromGlobal).toEqual(["fs"]);
  });

  it("when `selection` excludes every entry at a Claude scope, no Claude rewrite is emitted for that scope", () => {
    const plan = buildImportPlan(
      emptyInputs({
        claudeGlobal: claudeDoc("global", { fs: FS_ENTRY }),
        claudeProject: claudeDoc("project", { proj: PROJ_ENTRY }),
      }),
      { selection: new Set(["fs"]) }, // proj deselected
    );

    expect(findWrite(plan, RATEL_PROJECT)).toBeUndefined();
    expect(findWrite(plan, PROJECT_MCP)).toBeUndefined();
    expect(plan.claudeChanges.find((c) => c.path === HOME_CLAUDE)).toBeDefined();
  });
});
