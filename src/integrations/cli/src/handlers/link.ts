import type { RatelConfig } from "@ratel-ai/mcp-server";
import type { BackupManifest } from "../backup.js";
import { type ClaudeConfigDoc, readClaudeConfig } from "../claude.js";
import { ratelConfigPath } from "../hierarchy.js";
import { buildImportPlan } from "../import-plan.js";
import { readJson } from "../io.js";
import { locateRatelBin, type ResolvedBin } from "../locate-bin.js";
import { executePlan } from "../plan-exec.js";
import type { HandlerCtx } from "./types.js";

export interface LinkOptions {
  yes?: boolean;
  bin?: ResolvedBin;
  envVar?: string;
  whichResult?: string;
  workspaceRoot?: string;
  exists?: (path: string) => Promise<boolean>;
}

export async function runLink(
  ctx: HandlerCtx,
  opts: LinkOptions = {},
): Promise<BackupManifest | null> {
  ctx.prompts.intro("Ratel · link Claude Code at Ratel");

  const claudeUser = await readClaudeConfig("user", ctx.env, ctx.fs);
  const claudeProject = ctx.env.projectRoot
    ? await readClaudeConfig("project", ctx.env, ctx.fs)
    : null;
  const claudeLocal =
    ctx.env.cwd || ctx.env.projectRoot ? await readClaudeConfig("local", ctx.env, ctx.fs) : null;

  if (!ctx.env.projectRoot && ctx.env.projectRootError) {
    const e = ctx.env.projectRootError;
    ctx.log(
      `[ratel] no project root detected (searched ${e.markers.join(", ")} from ${e.searchedFrom}). Claude project scope and Ratel local target unavailable.`,
    );
  }

  const ratelUserPath = ratelConfigPath("user", ctx.env);
  const ratelProjectPath = ctx.env.projectRoot ? ratelConfigPath("project", ctx.env) : undefined;
  const ratelLocalPath = ctx.env.projectRoot ? ratelConfigPath("local", ctx.env) : undefined;

  const ratelUser = await readJson<RatelConfig>(ctx.fs, ratelUserPath);
  const ratelProject = ratelProjectPath
    ? await readJson<RatelConfig>(ctx.fs, ratelProjectPath)
    : null;
  const ratelLocal = ratelLocalPath ? await readJson<RatelConfig>(ctx.fs, ratelLocalPath) : null;

  const ratelKnown = new Set<string>();
  for (const cfg of [ratelUser, ratelProject, ratelLocal]) {
    if (cfg) for (const name of Object.keys(cfg.mcpServers)) ratelKnown.add(name);
  }
  if (ratelKnown.size === 0) {
    ctx.prompts.note("No Ratel entries found at any scope. Nothing to link.");
    ctx.prompts.outro("done");
    return null;
  }

  const claudeKnown = collectClaudeNames(claudeUser, claudeProject, claudeLocal);
  const overlap = [...claudeKnown].filter((n) => ratelKnown.has(n));
  if (overlap.length === 0) {
    ctx.prompts.note(
      "No Claude entries match any Ratel entry. Run `import` to migrate Claude entries first.",
    );
    ctx.prompts.outro("done");
    return null;
  }

  const bin = opts.bin ?? (await resolveBin(ctx, opts));

  const plan = buildImportPlan(
    {
      claudeUser,
      claudeProject,
      claudeLocal,
      ratelUser,
      ratelProject,
      ratelLocal,
      bin,
      ratelUserPath,
      ratelProjectPath,
      ratelLocalPath,
      projectRoot: ctx.env.projectRoot,
    },
    { selection: new Set(overlap) },
  );

  if (plan.claudeChanges.length === 0) {
    ctx.prompts.outro("nothing to do (Claude already points at Ratel)");
    return null;
  }

  ctx.prompts.note(renderClaudeStage(plan), "Claude rewrites");

  if (!opts.yes) {
    const ok = await ctx.prompts.confirm({
      message: `Replace ${plan.claudeChanges.length} Claude entr${
        plan.claudeChanges.length === 1 ? "y" : "ies"
      } with the ratel entry?`,
      initialValue: true,
    });
    if (ctx.prompts.isCancel(ok) || ok === false) {
      ctx.prompts.cancel("link cancelled");
      return null;
    }
  }

  const manifest = await executePlan(plan.claudeChanges, {
    fs: ctx.fs,
    env: ctx.env,
    action: "link",
  });
  ctx.prompts.note(`Backup created. Run \`ratel-mcp-server undo\` to revert.`, "Done");
  ctx.prompts.outro("link complete · restart Claude to pick up the new MCP entry");
  return manifest;
}

function collectClaudeNames(
  global: ClaudeConfigDoc | null,
  project: ClaudeConfigDoc | null,
  local: ClaudeConfigDoc | null,
): Set<string> {
  const out = new Set<string>();
  for (const doc of [global, project, local]) {
    if (!doc) continue;
    for (const name of Object.keys(doc.mcpServers)) {
      if (name !== "ratel") out.add(name);
    }
  }
  return out;
}

async function resolveBin(ctx: HandlerCtx, opts: LinkOptions): Promise<ResolvedBin> {
  return locateRatelBin({
    envVar: opts.envVar ?? process.env.RATEL_BIN,
    whichResult: opts.whichResult ?? (await whichRatelBin()),
    workspaceRoot: opts.workspaceRoot,
    exists: opts.exists,
    promptForPath: async () => {
      const v = await ctx.prompts.text({ message: "Path to ratel binary?" });
      return ctx.prompts.isCancel(v) ? "" : (v as string);
    },
  });
}

async function whichRatelBin(): Promise<string | undefined> {
  try {
    const { execSync } = await import("node:child_process");
    const out = execSync("which ratel", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function renderClaudeStage(plan: ReturnType<typeof buildImportPlan>): string {
  return plan.claudeChanges
    .map((c) => `write ${c.path}${c.before === null ? " (new file)" : ""}`)
    .join("\n");
}
