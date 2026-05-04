import type { BackupManifest } from "../backup.js";
import { type ClaudeConfigDoc, type ClaudeScope, readClaudeConfig } from "../claude.js";
import type { RatelConfig } from "../config.js";
import { ratelConfigPath } from "../hierarchy.js";
import { buildImportPlan, type FileChange, type ImportPlan } from "../import-plan.js";
import { readJson } from "../io.js";
import { locateRatelBin, type ResolvedBin } from "../locate-bin.js";
import { executePlan } from "../plan-exec.js";
import type { HandlerCtx } from "./types.js";

export interface ImportFlowOptions {
  yes?: boolean;
  dryRun?: boolean;
  bin?: ResolvedBin;
  envVar?: string;
  whichResult?: string;
  workspaceRoot?: string;
  exists?: (path: string) => Promise<boolean>;
}

interface Candidate {
  name: string;
  scope: ClaudeScope;
  hasDescription: boolean;
}

export async function runImport(
  ctx: HandlerCtx,
  opts: ImportFlowOptions = {},
): Promise<BackupManifest | null> {
  ctx.prompts.intro("Ratel · import Claude Code MCP servers");

  const claudeGlobal = await readClaudeConfig("global", ctx.env, ctx.fs);
  const claudeProject = ctx.env.projectRoot
    ? await readClaudeConfig("project", ctx.env, ctx.fs)
    : null;
  const claudeLocal = ctx.env.projectRoot ? await readClaudeConfig("local", ctx.env, ctx.fs) : null;

  const candidates = collectCandidates(claudeGlobal, claudeProject, claudeLocal);
  if (candidates.length === 0) {
    ctx.prompts.note("No Claude Code MCP servers found at any scope. Nothing to import.");
    ctx.prompts.outro("done");
    return null;
  }

  const ratelGlobalPath = ratelConfigPath("global", ctx.env);
  const ratelProjectPath = ctx.env.projectRoot ? ratelConfigPath("project", ctx.env) : undefined;
  const ratelLocalPath = ctx.env.projectRoot ? ratelConfigPath("local", ctx.env) : undefined;

  const bin = opts.bin ?? (await resolveBin(ctx, opts));

  const ratelGlobal = await readJson<RatelConfig>(ctx.fs, ratelGlobalPath);
  const ratelProject = ratelProjectPath
    ? await readJson<RatelConfig>(ctx.fs, ratelProjectPath)
    : null;
  const ratelLocal = ratelLocalPath ? await readJson<RatelConfig>(ctx.fs, ratelLocalPath) : null;

  const selection = await selectCandidates(ctx, candidates, opts);
  if (selection === null) {
    ctx.prompts.cancel("import cancelled");
    return null;
  }

  await captureDescriptions(ctx, selection, claudeGlobal, claudeProject, claudeLocal, opts);

  const plan = buildImportPlan(
    {
      claudeGlobal,
      claudeProject,
      claudeLocal,
      ratelGlobal,
      ratelProject,
      ratelLocal,
      bin,
      ratelGlobalPath,
      ratelProjectPath,
      ratelLocalPath,
      projectRoot: ctx.env.projectRoot,
    },
    { selection: new Set(selection.map((c) => c.name)) },
  );

  ctx.prompts.note(renderSummary(plan), "Summary");

  if (plan.ratelChanges.length === 0 && plan.claudeChanges.length === 0) {
    ctx.prompts.outro("nothing to do");
    return null;
  }

  if (opts.dryRun) {
    for (const c of [...plan.ratelChanges, ...plan.claudeChanges]) {
      if (c.kind === "write") ctx.log(`would write ${c.path}`);
    }
    ctx.prompts.outro("dry-run complete");
    return null;
  }

  // Stage A — Ratel writes
  let stageAManifest: BackupManifest | null = null;
  if (plan.ratelChanges.length > 0) {
    ctx.prompts.note(renderDiff(plan.ratelChanges), "Stage A · Ratel config writes");
    if (!opts.yes) {
      const ok = await ctx.prompts.confirm({
        message: `Apply ${plan.ratelChanges.length} Ratel config change(s)?`,
        initialValue: true,
      });
      if (ctx.prompts.isCancel(ok) || ok === false) {
        ctx.prompts.cancel("import cancelled (no writes)");
        return null;
      }
    }
    stageAManifest = await tryExecute(ctx, plan.ratelChanges, "import");
  }

  // Stage B — Claude rewrites
  if (plan.claudeChanges.length === 0) {
    ctx.prompts.outro("import complete · no Claude changes needed");
    return stageAManifest;
  }

  ctx.prompts.note(renderClaudeStage(plan), "Stage B · Claude config rewrites");
  if (!opts.yes) {
    const ok = await ctx.prompts.confirm({
      message: `Replace ${plan.claudeChanges.length} Claude entr${
        plan.claudeChanges.length === 1 ? "y" : "ies"
      } with the ratel entry?`,
      initialValue: true,
    });
    if (ctx.prompts.isCancel(ok) || ok === false) {
      ctx.log(
        "Stage B skipped. Run `ratel-mcp-server link` (or re-run `ratel-mcp-server import`) to point Claude at Ratel later.",
      );
      ctx.prompts.outro("Stage A applied · Stage B deferred");
      return stageAManifest;
    }
  }

  const stageBManifest = await tryExecute(ctx, plan.claudeChanges, "import");
  ctx.prompts.note(`Backup created. Run \`ratel-mcp-server undo\` to revert.`, "Done");
  ctx.prompts.outro("import complete · restart Claude to pick up the new MCP entry");
  return stageBManifest;
}

function collectCandidates(
  global: ClaudeConfigDoc | null,
  project: ClaudeConfigDoc | null,
  local: ClaudeConfigDoc | null,
): Candidate[] {
  const out: Candidate[] = [];
  for (const [scope, doc] of [
    ["global", global],
    ["project", project],
    ["local", local],
  ] as const) {
    if (!doc) continue;
    for (const [name, entry] of Object.entries(doc.mcpServers)) {
      if (name === "ratel") continue;
      out.push({ name, scope, hasDescription: typeof entry.description === "string" });
    }
  }
  return out;
}

async function selectCandidates(
  ctx: HandlerCtx,
  candidates: Candidate[],
  opts: ImportFlowOptions,
): Promise<Candidate[] | null> {
  if (opts.yes) return candidates;
  const picked = await ctx.prompts.multiselect<string>({
    message: "Pick the upstream MCPs to migrate into Ratel",
    options: candidates.map((c) => ({
      value: tagOf(c),
      label: `${c.name} [${c.scope}]`,
    })),
    initialValues: candidates.map(tagOf),
    required: false,
  });
  if (ctx.prompts.isCancel(picked)) return null;
  const selected = picked as string[];
  const set = new Set(selected);
  return candidates.filter((c) => set.has(tagOf(c)));
}

function tagOf(c: Candidate): string {
  return `${c.scope}:${c.name}`;
}

async function captureDescriptions(
  ctx: HandlerCtx,
  selected: Candidate[],
  global: ClaudeConfigDoc | null,
  project: ClaudeConfigDoc | null,
  local: ClaudeConfigDoc | null,
  opts: ImportFlowOptions,
): Promise<void> {
  if (opts.yes) return;
  const docByScope: Record<ClaudeScope, ClaudeConfigDoc | null> = {
    global,
    project,
    local,
  };
  for (const c of selected) {
    if (c.hasDescription) continue;
    const entry = docByScope[c.scope]?.mcpServers[c.name];
    if (!entry) continue;
    const v = await ctx.prompts.text({
      message: `Optional description for "${c.name}" [${c.scope}]?`,
      placeholder: "(leave blank to skip)",
    });
    if (ctx.prompts.isCancel(v)) continue;
    const text = (v as string).trim();
    if (text.length > 0) entry.description = text;
  }
}

async function tryExecute(
  ctx: HandlerCtx,
  changes: readonly FileChange[],
  action: BackupManifest["action"],
): Promise<BackupManifest> {
  try {
    return await executePlan(changes, { fs: ctx.fs, env: ctx.env, action });
  } catch (err) {
    ctx.log(`error during execution: ${(err as Error).message}`);
    ctx.log(
      `partial backup may exist under ~/.ratel/backups/. Run \`ratel-mcp-server undo\` to revert.`,
    );
    throw err;
  }
}

async function resolveBin(ctx: HandlerCtx, opts: ImportFlowOptions): Promise<ResolvedBin> {
  return locateRatelBin({
    envVar: opts.envVar ?? process.env.RATEL_MCP_BIN,
    whichResult: opts.whichResult ?? (await whichRatelBin()),
    workspaceRoot: opts.workspaceRoot,
    exists: opts.exists,
    promptForPath: async () => {
      const v = await ctx.prompts.text({
        message: "Path to ratel-mcp-server binary?",
      });
      return ctx.prompts.isCancel(v) ? "" : (v as string);
    },
  });
}

async function whichRatelBin(): Promise<string | undefined> {
  try {
    const { execSync } = await import("node:child_process");
    const out = execSync("which ratel-mcp-server", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function renderSummary(plan: ImportPlan): string {
  const lines: string[] = [];
  if (plan.summary.movedFromGlobal.length > 0) {
    lines.push(`global: ${plan.summary.movedFromGlobal.join(", ")}`);
  }
  if (plan.summary.movedFromProject.length > 0) {
    lines.push(`project: ${plan.summary.movedFromProject.join(", ")}`);
  }
  if (plan.summary.movedFromLocal.length > 0) {
    lines.push(`local: ${plan.summary.movedFromLocal.join(", ")}`);
  }
  if (plan.summary.skipped.length > 0) {
    lines.push("");
    lines.push("Skipped (will stay in their current Claude config):");
    for (const s of plan.summary.skipped) {
      lines.push(`  - ${s.name} (${s.scope}): ${s.reason}`);
    }
  }
  if (plan.summary.overwrittenRatelEntries.length > 0) {
    lines.push("");
    lines.push(
      `Overwriting existing Claude ratel entry at: ${plan.summary.overwrittenRatelEntries.join(
        ", ",
      )}`,
    );
  }
  return lines.length > 0 ? lines.join("\n") : "(no changes)";
}

function renderDiff(changes: readonly FileChange[]): string {
  return changes
    .map((c) => {
      if (c.kind !== "write") return `delete ${c.path}`;
      return `write ${c.path}${c.before === null ? " (new file)" : ""}`;
    })
    .join("\n");
}

function renderClaudeStage(plan: ImportPlan): string {
  const lines: string[] = [];
  lines.push(renderDiff(plan.claudeChanges));
  if (plan.summary.skipped.length > 0) {
    lines.push("");
    lines.push("Entries that will remain in Claude as-is:");
    for (const s of plan.summary.skipped) {
      lines.push(`  - ${s.name} (${s.scope})`);
    }
  }
  return lines.join("\n");
}
