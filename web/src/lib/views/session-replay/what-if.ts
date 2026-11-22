import { and, desc, eq } from "drizzle-orm";
import { runtimeCatalogEntries } from "@/lib/ingest/runtime-catalog/schema";
import { traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { CANT_SIMULATE } from "@/lib/views/eval-gate/method";
import type { FixChange, ToolDef } from "@/lib/views/eval-gate/types";
import { type SessionReplayRunRow, sessionReplayRuns } from "@/lib/views/session-replay/schema";
import { DEFAULT_K, MAX_K } from "./fork";
import { type RequestWhatIfDeps, requestWhatIf, WhatIfError } from "./runs";
import type { SessionTimeline } from "./timeline";
import type { Variant } from "./variant";

/**
 * The What-if panel's server side (RC-178): what a person may fork a step
 * with, queue a run, read it back while it runs, and add its run to the
 * task's eval set. Every call checks that the caller is a member of the
 * project; `requestWhatIf`
 * checks the content opt-in (a model replay needs it, else it re-ranks).
 *
 * The client names a change (a fix id, a catalog tool and its text); the
 * server builds the variant, so a fix's change is always the one Fixes shows.
 */

/** A change as the panel sends it. */
export type ChangeSpec =
  | { kind: "fix"; fixId: string }
  | { kind: "catalog_override"; tool: string; searchable: string }
  | { kind: "definition"; tool: string; description: string }
  | { kind: "remove_tool"; tool: string };

export interface SubmitInput {
  projectId: string;
  turnId: string;
  /** The model call to fork, 0-based in its turn. */
  step: number;
  k: number;
  change: ChangeSpec;
}

export interface WhatIfOptions {
  fixes: { id: string; title: string; craft: boolean }[];
  tools: { name: string; description: string; searchable: string }[];
}

export interface SideView {
  choice: string | null;
  distribution: { tool: string; count: number }[];
  /** Per sample. */
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface WhatIfRunView {
  id: string;
  turnId: string;
  step: number;
  status: "queued" | "running" | "completed" | "failed";
  method: string;
  k: number;
  changeKind: string;
  recordedTool: string | null;
  before: SideView | null;
  after: SideView | null;
  error: string | null;
  spentUsd: number;
}

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface WhatIfDeps {
  db?: ReturnType<typeof getDb>;
  getSession: () => Promise<{ user: { id: string; externalId: string } } | null>;
  findProjectScope: (
    projectId: string,
    userId: string,
  ) => Promise<{ project: { id: string }; organization: { id: string } } | null>;
  /** A fix of the project as Fixes reads it, with the change a simulation applies; null when it is unknown or can't be simulated yet. */
  resolveFix?: (
    projectId: string,
    fixId: string,
    actor: string,
  ) => Promise<{ change: FixChange; craft: boolean } | { error: string } | null>;
  /** Passed through to `requestWhatIf` (the queue, the budget, the clock). */
  request?: Omit<RequestWhatIfDeps, "db">;
  /** Add a run to its task's eval set. */
  addToEvalSet?: (input: {
    projectId: string;
    taskId: string;
    action: "add";
    runId: string;
  }) => Promise<{ ok: true; message: string } | { ok: false; error: string }>;
  track?: (event: {
    externalId: string;
    projectId: string;
    organizationId: string;
    changeKind: string;
    k: number;
    method: string;
    runId: string;
  }) => Promise<void>;
}

const logger = getLogger("session-replay/what-if");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 4000;
const LIVE = new Set(["queued", "running"]);

const RUN_ERRORS: Record<string, string> = {
  bad_variant: "The change could not be read.",
  flag_off: "Session replay was turned off before the run started.",
  not_found: "The step is no longer available.",
  not_affected: "Nothing the change touches is in what this step's model saw.",
  timed_out: "The run took too long and stopped.",
  ...CANT_SIMULATE,
};

/** Queue a What-if run for one model call of a session, or return the live one for the same change. */
export async function submitWhatIf(
  raw: unknown,
  deps: WhatIfDeps,
): Promise<ActionResult<WhatIfRunView>> {
  const input = parseSubmit(raw);
  if (!input) return { ok: false, error: "The What-if settings are invalid." };
  const caller = await member(input.projectId, deps);
  if (!caller.ok) return caller;
  const { actor, organizationId } = caller.value;
  const db = deps.db ?? getDb();
  const built = await buildVariant(input.projectId, input.change, actor, deps, db);
  if (!built.ok) return built;
  try {
    const { run, created } = await requestWhatIf(
      {
        projectId: input.projectId,
        actor,
        turnId: input.turnId,
        step: input.step,
        k: input.k,
        variant: built.value.variant,
        variantRef: built.value.ref,
      },
      { ...deps.request, db },
    );
    if (created) {
      logger.info(
        {
          project_id: input.projectId,
          run_id: run.id,
          change_kind: run.variantKind,
          k: run.k,
          method: run.method,
          actor,
        },
        "what_if_submitted",
      );
      await deps.track?.({
        externalId: actor,
        projectId: input.projectId,
        organizationId,
        changeKind: run.variantKind,
        k: run.k,
        method: run.method,
        runId: run.id,
      });
    }
    return { ok: true, value: runView(run) };
  } catch (err) {
    if (err instanceof WhatIfError) return { ok: false, error: err.message };
    throw err;
  }
}

/** One What-if run of the project, for the panel's polling. */
export async function getWhatIfRun(
  projectId: string,
  runId: string,
  deps: WhatIfDeps,
): Promise<ActionResult<WhatIfRunView>> {
  const caller = await member(projectId, deps);
  if (!caller.ok) return caller;
  const run = await findRun(projectId, runId, deps.db ?? getDb());
  return run
    ? { ok: true, value: runView(run) }
    : { ok: false, error: "No What-if run in this project has that ID." };
}

/** Add the run a What-if forked to the eval set of its task. */
export async function addWhatIfToEvalSet(
  projectId: string,
  runId: string,
  deps: WhatIfDeps,
): Promise<ActionResult<string>> {
  const caller = await member(projectId, deps);
  if (!caller.ok) return caller;
  const db = deps.db ?? getDb();
  const run = await findRun(projectId, runId, db);
  if (!run) return { ok: false, error: "No What-if run in this project has that ID." };
  const [turn] = await db
    .select({ taskId: traceTurns.workflowId })
    .from(traceTurns)
    .where(and(eq(traceTurns.projectId, projectId), eq(traceTurns.id, run.turnId)))
    .limit(1);
  if (!turn?.taskId)
    return { ok: false, error: "This run belongs to no task, so it has no eval set." };
  if (!deps.addToEvalSet) throw new Error("addToEvalSet is not wired");
  const added = await deps.addToEvalSet({
    projectId,
    taskId: turn.taskId,
    action: "add",
    runId: run.turnId,
  });
  logger.info(
    {
      project_id: projectId,
      run_id: run.id,
      task_id: turn.taskId,
      outcome: added.ok ? "added" : "refused",
    },
    "what_if_added_to_eval_set",
  );
  return added.ok ? { ok: true, value: added.message } : added;
}

/** The session's What-if runs, newest first. The caller has checked membership and the flag. */
export async function listWhatIfRuns(
  projectId: string,
  sessionId: string,
  db: Pick<ReturnType<typeof getDb>, "select"> = getDb(),
): Promise<WhatIfRunView[]> {
  const rows = await db
    .select()
    .from(sessionReplayRuns)
    .where(
      and(eq(sessionReplayRuns.projectId, projectId), eq(sessionReplayRuns.sessionId, sessionId)),
    )
    .orderBy(desc(sessionReplayRuns.createdAt))
    .limit(50);
  return rows.map(runView);
}

/** What the panel offers: the project's open fixes and its catalog tools. */
export async function loadWhatIfOptions(
  projectId: string,
  listFixes: (projectId: string) => Promise<{ id: string; title: string; source: string }[]>,
  db: Pick<ReturnType<typeof getDb>, "select"> = getDb(),
): Promise<WhatIfOptions> {
  const [fixes, tools] = await Promise.all([
    listFixes(projectId),
    db
      .select({
        name: runtimeCatalogEntries.entryId,
        description: runtimeCatalogEntries.description,
        searchable: runtimeCatalogEntries.searchableDescription,
        override: runtimeCatalogEntries.searchableDescriptionOverride,
      })
      .from(runtimeCatalogEntries)
      .where(eq(runtimeCatalogEntries.projectId, projectId))
      .orderBy(runtimeCatalogEntries.entryId)
      .limit(500),
  ]);
  return {
    fixes: fixes.map((fix) => ({ id: fix.id, title: fix.title, craft: fix.source === "craft" })),
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      searchable: tool.override ?? tool.searchable,
    })),
  };
}

/** Each model call of the timeline by its step index, as the turn and 0-based call a What-if forks. */
export function forkTargets(
  timeline: Pick<SessionTimeline, "steps">,
): Record<number, { turnId: string; call: number }> {
  const out: Record<number, { turnId: string; call: number }> = {};
  const seen = new Map<string, number>();
  for (const step of timeline.steps) {
    if (step.kind !== "model_call") continue;
    const call = seen.get(step.turnId) ?? 0;
    seen.set(step.turnId, call + 1);
    out[step.index] = { turnId: step.turnId, call };
  }
  return out;
}

/** The tools the session searched for or called, in the order it first met them: the panel offers them first. */
export function sessionTools(timeline: Pick<SessionTimeline, "steps">): string[] {
  const out = new Set<string>();
  for (const step of timeline.steps) {
    if (step.kind === "search") for (const id of step.hitIds) out.add(id);
    if (step.kind === "tool_call" && step.targetId) out.add(step.targetId);
  }
  return [...out];
}

/** The options with the session's tools first (in its order), then the rest by name. */
export function withSessionToolsFirst(
  options: WhatIfOptions,
  first: readonly string[],
): WhatIfOptions {
  const rank = new Map(first.map((name, i) => [name, i]));
  const tools = [...options.tools].sort(
    (a, b) =>
      (rank.get(a.name) ?? Infinity) - (rank.get(b.name) ?? Infinity) ||
      a.name.localeCompare(b.name),
  );
  return { ...options, tools };
}

/** A run as the panel shows it: per-sample tokens and cost, distributions largest first. */
export function runView(run: SessionReplayRunRow): WhatIfRunView {
  const side = (which: "before" | "after"): SideView | null => {
    if (run.status !== "completed" || !run.distribution || !run.tokens) return null;
    const tokens = run.tokens[which];
    const k = Math.max(1, run.k);
    return {
      choice: which === "before" ? run.beforeTool : run.afterTool,
      distribution: Object.entries(run.distribution[which])
        .map(([tool, count]) => ({ tool, count }))
        .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool)),
      inputTokens: Math.round(tokens.input / k),
      outputTokens: Math.round(tokens.output / k),
      costUsd: typeof tokens.costUsd === "number" ? tokens.costUsd / k : null,
    };
  };
  return {
    id: run.id,
    turnId: run.turnId,
    step: run.step,
    status: run.status as WhatIfRunView["status"],
    method: run.method,
    k: run.k,
    changeKind: run.variantKind,
    recordedTool: run.recordedTool,
    before: side("before"),
    after: side("after"),
    error:
      run.status === "failed"
        ? (RUN_ERRORS[run.errorCode ?? "failed"] ?? CANT_SIMULATE.failed)
        : null,
    // While reserved, `spend.usd` is the hold against the daily budget, not money spent.
    spentUsd: run.spend.reserved ? 0 : run.spend.usd,
  };
}

/** Whether a run is still going: the panel polls until it is not. */
export function isLive(run: Pick<WhatIfRunView, "status">): boolean {
  return LIVE.has(run.status);
}

async function member(
  projectId: string,
  deps: WhatIfDeps,
): Promise<ActionResult<{ actor: string; organizationId: string }>> {
  const session = await deps.getSession();
  if (!session) return { ok: false, error: "Sign in to use What-if." };
  const scope = UUID.test(projectId)
    ? await deps.findProjectScope(projectId, session.user.id)
    : null;
  if (!scope) return { ok: false, error: "No project you belong to has that ID." };
  const actor = session.user.externalId;
  return { ok: true, value: { actor, organizationId: scope.organization.id } };
}

async function buildVariant(
  projectId: string,
  change: ChangeSpec,
  actor: string,
  deps: WhatIfDeps,
  db: Pick<ReturnType<typeof getDb>, "select">,
): Promise<ActionResult<{ variant: Variant; ref: string }>> {
  switch (change.kind) {
    case "fix": {
      const fix = await deps.resolveFix?.(projectId, change.fixId, actor);
      if (!fix)
        return { ok: false, error: "That fix was replaced or is no longer open. Pick another." };
      if ("error" in fix) return { ok: false, error: fix.error };
      const tools = fix.change.replay?.tools ?? [];
      return {
        ok: true,
        value: {
          variant:
            fix.craft && tools.length > 0
              ? { kind: "tool_craft", tools }
              : { kind: "fix", change: fix.change },
          ref: change.fixId,
        },
      };
    }
    case "catalog_override":
    case "definition":
    case "remove_tool": {
      const [entry] = await db
        .select({
          name: runtimeCatalogEntries.entryId,
          inputSchema: runtimeCatalogEntries.inputSchema,
        })
        .from(runtimeCatalogEntries)
        .where(
          and(
            eq(runtimeCatalogEntries.projectId, projectId),
            eq(runtimeCatalogEntries.entryId, change.tool),
          ),
        )
        .limit(1);
      if (!entry) return { ok: false, error: "No tool in this project's catalog has that name." };
      if (change.kind === "remove_tool")
        return {
          ok: true,
          value: { variant: { kind: "remove_tool", tool: entry.name }, ref: entry.name },
        };
      if (change.kind === "catalog_override")
        return {
          ok: true,
          value: {
            variant: { kind: "catalog_override", tool: entry.name, searchable: change.searchable },
            ref: entry.name,
          },
        };
      const tool: ToolDef = {
        name: entry.name,
        description: change.description,
        parameters: (entry.inputSchema as Record<string, unknown> | null) ?? {
          type: "object",
          properties: {},
        },
      };
      return { ok: true, value: { variant: { kind: "definition", tool }, ref: entry.name } };
    }
  }
}

function parseSubmit(raw: unknown): SubmitInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.projectId !== "string" ||
    typeof value.turnId !== "string" ||
    !UUID.test(value.turnId)
  )
    return null;
  if (!Number.isInteger(value.step) || (value.step as number) < 0) return null;
  const k = value.k === undefined ? DEFAULT_K : value.k;
  if (!Number.isInteger(k) || (k as number) < 1 || (k as number) > MAX_K) return null;
  const change = parseChangeSpec(value.change);
  return change
    ? {
        projectId: value.projectId,
        turnId: value.turnId,
        step: value.step as number,
        k: k as number,
        change,
      }
    : null;
}

function parseChangeSpec(raw: unknown): ChangeSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const text = (key: string) =>
    typeof value[key] === "string" &&
    (value[key] as string).trim() !== "" &&
    (value[key] as string).length <= MAX_TEXT
      ? (value[key] as string).trim()
      : null;
  switch (value.kind) {
    case "fix":
      return text("fixId") ? { kind: "fix", fixId: text("fixId")! } : null;
    case "catalog_override":
      return text("tool") && text("searchable")
        ? { kind: "catalog_override", tool: text("tool")!, searchable: text("searchable")! }
        : null;
    case "definition":
      return text("tool") && text("description")
        ? { kind: "definition", tool: text("tool")!, description: text("description")! }
        : null;
    case "remove_tool":
      return text("tool") ? { kind: "remove_tool", tool: text("tool")! } : null;
    default:
      return null;
  }
}

async function findRun(
  projectId: string,
  runId: string,
  db: Pick<ReturnType<typeof getDb>, "select">,
): Promise<SessionReplayRunRow | null> {
  if (!UUID.test(runId)) return null;
  const [row] = await db
    .select()
    .from(sessionReplayRuns)
    .where(and(eq(sessionReplayRuns.projectId, projectId), eq(sessionReplayRuns.id, runId)))
    .limit(1);
  return row ?? null;
}
