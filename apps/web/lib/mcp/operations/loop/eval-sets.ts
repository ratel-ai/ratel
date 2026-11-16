import { z } from "zod";
import { invalidParams, McpOperationError, notFound } from "@/lib/mcp/errors";
import { projectScoped, uuidParam } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation, type OperationContext } from "@/lib/mcp/registry";
import { capRows, limitParam, TruncationTracker } from "@/lib/mcp/serialize";
import { type ServerEventName, trackServerEvent } from "@/lib/platform/telemetry";
import { dismissCraftProposal } from "@/lib/synthesis/tool-crafter/queries";
import { parseExpected } from "@/lib/views/eval-gate/defaults";
import { evalGateEnabledForActor } from "@/lib/views/eval-gate/gate";
import {
  type EvalGatePageModel,
  type EvalRunSummary,
  loadEvalGatePage,
} from "@/lib/views/eval-gate/page-model";
import type { FixEvalSetRow } from "@/lib/views/eval-gate/schema";
import {
  addRunToSet,
  ensureEvalSet,
  type FixContext,
  loadFixContext,
  topUpEvalSet,
} from "@/lib/views/eval-gate/service";
import { getEvalSet, listCases, removeCase, updateCase } from "@/lib/views/eval-gate/store";
import type { EvalCase, Expected } from "@/lib/views/eval-gate/types";
import { evalHref } from "@/lib/views/eval-gate/view";
import { SAVINGS_PERIODS, type SavingsPeriod, savingsForPeriod } from "@/lib/views/fixes/period";
import { findFix } from "@/lib/views/fixes/select";
import type { Fix, FixesModel, FixStats } from "@/lib/views/fixes/types";
import { loadProjectFixes } from "./read";
import { evalGateOff, mcpActor, mcpEventContext } from "./tasks";

/**
 * A fix's eval set (RC-46) as tools: read the page the console shows at
 * Fixes › a fix › Eval, and make the same edits its server actions make
 * (`app/(app)/project/[projectId]/improvement/fixes/eval-actions.ts`), through
 * the same `lib/eval-gate` calls. Both behind `cloud-eval-gate`, decided for the
 * caller in the project's organization, as the page is. Plus `dismiss_fix`,
 * the Fixes list's Dismiss on a drafted tool change, which has no flag.
 */

export interface FixEvalSetDeps {
  evalGateEnabled: (projectId: string, actor: string) => Promise<boolean>;
  loadFixContext: (projectId: string, fixId: string) => Promise<FixContext | null>;
  loadEvalGatePage: (
    projectId: string,
    fixId: string,
    fix: Fix | null,
    actor: string,
  ) => Promise<EvalGatePageModel>;
  getEvalSet: (projectId: string, fixId: string) => Promise<FixEvalSetRow | null>;
  ensureEvalSet: (
    ctx: FixContext,
    actor: string,
  ) => Promise<{ set: FixEvalSetRow; created: boolean }>;
  topUpEvalSet: (set: FixEvalSetRow, fix: Fix) => Promise<number>;
  addRunToSet: (set: FixEvalSetRow, fix: Fix | null, raw: string) => ReturnType<typeof addRunToSet>;
  listCases: (setId: string) => Promise<EvalCase[]>;
  updateCase: (
    setId: string,
    caseId: string,
    patch: { expected: Expected; outcome: string; criteria: string },
  ) => Promise<boolean>;
  removeCase: (setId: string, caseId: string) => Promise<boolean>;
  loadProjectFixes: (projectId: string) => Promise<FixesModel | null>;
  dismissCraftProposal: (projectId: string, proposalId: string, now: Date) => Promise<boolean>;
  trackServerEvent: typeof trackServerEvent;
  now: () => Date;
}

export const defaultFixEvalSetDeps: FixEvalSetDeps = {
  evalGateEnabled: (projectId, actor) => evalGateEnabledForActor(projectId, actor),
  loadFixContext,
  loadEvalGatePage: (projectId, fixId, fix, actor) =>
    loadEvalGatePage(projectId, fixId, fix, undefined, actor),
  getEvalSet: (projectId, fixId) => getEvalSet(projectId, fixId),
  ensureEvalSet: (ctx, actor) => ensureEvalSet(ctx, actor),
  topUpEvalSet: (set, fix) => topUpEvalSet(set, fix),
  addRunToSet: (set, fix, raw) => addRunToSet(set, fix, raw),
  listCases: (setId) => listCases(setId),
  updateCase: (setId, caseId, patch) => updateCase(setId, caseId, patch),
  removeCase: (setId, caseId) => removeCase(setId, caseId),
  loadProjectFixes,
  dismissCraftProposal: (projectId, proposalId, now) =>
    dismissCraftProposal(projectId, proposalId, now),
  trackServerEvent,
  now: () => new Date(),
};

/** The fix ids the eval page opens, as its route checks them. */
const FIX_ID = /^(rewrite|craft|issue|intent):\S{1,200}$/;
const MAX_TEXT = 2_000;

const fixIdParam = z
  .string()
  .regex(FIX_ID, "a fix id: rewrite:, craft:, issue: or intent: and its id")
  .describe("A fix id from list_fixes or get_fix, e.g. issue:<uuid>, craft:<uuid>.");

async function requireEvalGate(deps: FixEvalSetDeps, ctx: OperationContext): Promise<string> {
  const actor = mcpActor(ctx.auth, ctx.projectId);
  if (!(await deps.evalGateEnabled(ctx.projectId, actor))) throw evalGateOff();
  return actor;
}

async function track(
  deps: FixEvalSetDeps,
  ctx: OperationContext,
  event: ServerEventName,
  fixId: string,
  properties: Record<string, unknown> = {},
) {
  await deps.trackServerEvent(event, mcpEventContext(ctx), {
    object_action: event,
    fix_id: fixId,
    surface: "mcp",
    ...properties,
  });
}

function runView(run: EvalRunSummary) {
  return {
    id: run.id,
    status: run.status,
    verdict: run.verdict,
    before: run.before,
    after: run.after,
    cases: run.nCases,
    simulated: run.nSimulated,
    interval: run.interval,
    evidence: run.evidence,
    breakdown: run.breakdown,
    method: run.method,
    methods: run.methods,
    judge: run.judge,
    replay: run.replay,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    error: run.error,
  };
}

function caseView(item: EvalGatePageModel["cases"][number], tracker: TruncationTracker) {
  const result = item.result;
  return {
    caseId: item.id,
    runId: item.turnId,
    traceId: item.traceId,
    origin: item.origin,
    originLabel: item.originLabel,
    role: item.role,
    expected: item.expected,
    expectedText: tracker.text(item.expectedText, 400),
    outcome: tracker.text(item.outcome, 600),
    criteria: tracker.text(item.criteria, 600),
    result: result
      ? {
          simulated: result.simulated,
          skipped: item.skippedLabel,
          method: item.methodLabel,
          methodNote: item.methodNote,
          before: result.before ? { pass: result.before.pass, score: result.before.score } : null,
          after: result.after ? { pass: result.after.pass, score: result.after.score } : null,
          replayFailed: result.replayFailed ?? false,
        }
      : null,
    runHref: item.runHref,
  };
}

function evalSetView(model: EvalGatePageModel, limit: number, tracker: TruncationTracker) {
  return {
    fixId: model.fixId,
    fix: model.fix,
    source: model.source,
    method: model.method,
    blocked: model.blocked,
    set: model.set
      ? {
          ...model.set,
          change: tracker.take(capRows(model.set.change, 20)),
          replayChange: tracker.take(capRows(model.set.replayChange, 20)),
        }
      : null,
    badge: model.badge,
    latest: model.latest ? runView(model.latest) : null,
    caseCount: model.cases.length,
    cases: tracker.take(capRows(model.cases, limit)).map((item) => caseView(item, tracker)),
    history: tracker.take(capRows(model.history, 5)).map(runView),
    href: evalHref(model.projectId, model.fixId),
  };
}

const expectedFields = {
  tool: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .optional()
    .describe("The tool that should be in the first list the agent sees; null clears it."),
  maxToolCalls: z.number().int().nonnegative().nullable().optional(),
  maxSearches: z.number().int().nonnegative().nullable().optional(),
  maxFailedCalls: z.number().int().nonnegative().nullable().optional(),
  avoidTools: z
    .array(z.string().trim().min(1).max(500))
    .max(50)
    .optional()
    .describe("Tools the run should not call."),
  endsWell: z.boolean().nullable().optional(),
  maxSelfCorrections: z.number().int().nonnegative().nullable().optional(),
  maxCostUsd: z.number().finite().nonnegative().nullable().optional(),
  maxLatencyMs: z.number().int().nonnegative().nullable().optional(),
  outcome: z.string().max(MAX_TEXT).optional().describe("What the run should achieve, in words."),
  criteria: z.string().max(MAX_TEXT).optional().describe("What a judge checks, in words."),
};
type ExpectedEdit = { [K in keyof typeof expectedFields]?: z.infer<(typeof expectedFields)[K]> };
const EXPECTED_KEYS = Object.keys(expectedFields).filter(
  (key) => key !== "outcome" && key !== "criteria",
) as (keyof Expected)[];

/** The checks an edit turns on, named as the console's event names them. */
function checksOf(expected: Expected, outcome: string, criteria: string): string[] {
  return [
    expected.tool && "right_tool",
    expected.maxToolCalls !== null && "max_tool_calls",
    expected.maxSearches !== null && "max_searches",
    expected.maxFailedCalls !== null && "max_failed_calls",
    expected.avoidTools.length > 0 && "avoid_tools",
    expected.endsWell === true && "ends_well",
    expected.maxSelfCorrections != null && "max_self_corrections",
    expected.maxCostUsd != null && "max_cost",
    expected.maxLatencyMs != null && "max_latency",
    (outcome || criteria) && "criteria",
  ].filter((check): check is string => typeof check === "string");
}

/** The case's expected outcome with the given fields replaced; a field left out keeps its value. */
function editedCase(current: EvalCase, edit: ExpectedEdit) {
  const given = Object.fromEntries(
    EXPECTED_KEYS.flatMap((key) => (edit[key] === undefined ? [] : [[key, edit[key]]])),
  );
  return {
    expected: parseExpected({ ...current.expected, ...given }),
    outcome: (edit.outcome ?? current.outcome).trim(),
    criteria: (edit.criteria ?? current.criteria).trim(),
  };
}

type ChangeParams = ExpectedEdit & {
  fixId: string;
  action: "create" | "top_up" | "add_run" | "update_case" | "remove_case";
  runId?: string;
  caseId?: string;
};

async function openFix(
  deps: FixEvalSetDeps,
  ctx: OperationContext,
  fixId: string,
): Promise<FixContext> {
  const fix = await deps.loadFixContext(ctx.projectId, fixId);
  if (!fix)
    throw new McpOperationError(
      "not_found",
      "This fix isn't open any more, so its eval set can't pick runs for it.",
    );
  return fix;
}

async function existingSet(
  deps: FixEvalSetDeps,
  ctx: OperationContext,
  fixId: string,
): Promise<FixEvalSetRow> {
  const set = await deps.getEvalSet(ctx.projectId, fixId);
  if (!set)
    throw notFound("eval set for this fix. change_fix_eval_set with action create makes one");
  return set;
}

/** One edit, as the console's eval actions make it; returns what the tool reports. */
async function changeEvalSet(
  deps: FixEvalSetDeps,
  ctx: OperationContext,
  actor: string,
  params: ChangeParams,
) {
  switch (params.action) {
    case "create": {
      const fix = await openFix(deps, ctx, params.fixId);
      const { set, created } = await deps.ensureEvalSet(fix, actor);
      if (created) await track(deps, ctx, "fix_eval_set_created", fix.fix.id, { set_id: set.id });
      return {
        setId: set.id,
        fixId: set.fixId,
        created,
        message: created
          ? "Eval set made from the project's runs."
          : "The fix already has an eval set.",
      };
    }
    case "top_up": {
      const fix = await openFix(deps, ctx, params.fixId);
      const { set } = await deps.ensureEvalSet(fix, actor);
      const added = await deps.topUpEvalSet(set, fix.fix);
      if (added > 0)
        await track(deps, ctx, "fix_eval_case_added", fix.fix.id, {
          set_id: set.id,
          added,
          how: "history",
        });
      return {
        setId: set.id,
        fixId: set.fixId,
        added,
        message:
          added > 0
            ? `Added ${added} ${added === 1 ? "run" : "runs"}.`
            : "No more runs touch this fix.",
      };
    }
    case "add_run": {
      const value = params.runId!.trim();
      const fix = await deps.loadFixContext(ctx.projectId, params.fixId);
      const set = fix
        ? (await deps.ensureEvalSet(fix, actor)).set
        : await existingSet(deps, ctx, params.fixId);
      const result = await deps.addRunToSet(set, fix?.fix ?? null, value);
      if (!result.ok)
        throw new McpOperationError("not_found", "No run of this project has that id.");
      if (result.added)
        await track(deps, ctx, "fix_eval_case_added", set.fixId, {
          set_id: set.id,
          added: 1,
          how: "manual",
        });
      return {
        setId: set.id,
        fixId: set.fixId,
        added: result.added ? 1 : 0,
        message: result.added ? "Run added." : "That run is already in the eval.",
      };
    }
    case "update_case": {
      const set = await existingSet(deps, ctx, params.fixId);
      const current = (await deps.listCases(set.id)).find((item) => item.id === params.caseId);
      if (!current) throw new McpOperationError("not_found", "This run is no longer in the eval.");
      const patch = editedCase(current, params);
      if (!(await deps.updateCase(set.id, current.id, patch)))
        throw new McpOperationError("not_found", "This run is no longer in the eval.");
      await track(deps, ctx, "fix_eval_case_updated", set.fixId, {
        set_id: set.id,
        case_id: current.id,
        checks: checksOf(patch.expected, patch.outcome, patch.criteria),
      });
      return {
        setId: set.id,
        fixId: set.fixId,
        caseId: current.id,
        expected: patch.expected,
        outcome: patch.outcome,
        criteria: patch.criteria,
        message: "Expected outcome saved.",
      };
    }
    case "remove_case": {
      const set = await existingSet(deps, ctx, params.fixId);
      if (!(await deps.removeCase(set.id, params.caseId!)))
        throw new McpOperationError("not_found", "This run was already removed.");
      await track(deps, ctx, "fix_eval_case_removed", set.fixId, {
        set_id: set.id,
        case_id: params.caseId,
      });
      return { setId: set.id, fixId: set.fixId, caseId: params.caseId, message: "Run removed." };
    }
  }
}

/** The Fixes page's numbers: counts, and the potential savings scaled to one period, as its period switch shows them. */
export function fixesSummary(stats: FixStats, period: SavingsPeriod, tracker: TruncationTracker) {
  const { total, tasks } = stats.savings;
  return {
    open: stats.open,
    ready: stats.ready,
    fromIssues: stats.fromIssues,
    issues: stats.issues,
    tools: stats.tools,
    roundTripsSaved: stats.roundTripsSaved,
    evidence: stats.evidence,
    savings: {
      period,
      periodLabel: SAVINGS_PERIODS[period].label,
      total: {
        saved: savingsForPeriod(total.absolute, total.windowDays, period),
        shareOfUsage: total.relative,
      },
      byTask: tracker.take(capRows(tasks, 10)).map((entry) => ({
        taskId: entry.task.id,
        task: entry.task.label,
        saved: savingsForPeriod(entry.absolute, entry.windowDays, period),
        shareOfUsage: entry.relative,
      })),
    },
  };
}

export function loopEvalSetReadOperations(
  deps: FixEvalSetDeps = defaultFixEvalSetDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "get_fix_eval_set",
      domain: "improvement",
      title: "Get a fix's eval set",
      description:
        "Read the runs a fix is simulated on: each case's expected outcome, role (holdout or evidence) and latest result, the change, method, why it is blocked, the latest simulation with interval, evidence, breakdown and judge, and earlier runs. Edit with change_fix_eval_set; simulate with run_eval.",
      keywords: ["fix eval set", "expected outcome", "holdout runs"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        fixId: fixIdParam,
        limit: limitParam.describe("Maximum cases to return (max 50)."),
      }),
      async execute(ctx, params) {
        const actor = await requireEvalGate(deps, ctx);
        const fix = await deps.loadFixContext(ctx.projectId, params.fixId);
        const model = await deps.loadEvalGatePage(
          ctx.projectId,
          params.fixId,
          fix?.fix ?? null,
          actor,
        );
        if (!fix && !model.set) throw notFound("fix");
        const tracker = new TruncationTracker();
        return {
          data: { evalSet: evalSetView(model, params.limit, tracker) },
          truncated: tracker.value,
          hint: model.set
            ? model.blocked
              ? `This fix has nothing to simulate: ${model.blocked}`
              : "change_fix_eval_set edits a case's expected outcome or the runs; run_eval simulates the fix on them."
            : "No eval set yet: change_fix_eval_set with action create picks runs, or run_eval makes one and simulates.",
        };
      },
    }),
  ];
}

export function loopEvalSetWriteOperations(
  deps: FixEvalSetDeps = defaultFixEvalSetDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "change_fix_eval_set",
      domain: "writes",
      title: "Change a fix's eval set",
      description:
        "Edit the runs a fix is simulated on: create picks them from history, top_up adds more, add_run adds one (runId: a run or trace id), update_case changes a case's expected outcome (fields left out keep their value), remove_case drops one. Read it with get_fix_eval_set.",
      keywords: ["edit eval set", "add eval run", "expected outcome edit"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        fixId: fixIdParam,
        action: z.enum(["create", "top_up", "add_run", "update_case", "remove_case"]),
        runId: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("add_run: a run id or a trace id."),
        caseId: uuidParam()
          .optional()
          .describe("update_case and remove_case: a caseId from get_fix_eval_set."),
        ...expectedFields,
      }),
      async execute(ctx, params) {
        if (params.action === "add_run" && !params.runId)
          throw invalidParams("add_run needs runId.");
        if ((params.action === "update_case" || params.action === "remove_case") && !params.caseId)
          throw invalidParams(`${params.action} needs caseId.`);
        const actor = await requireEvalGate(deps, ctx);
        const result = await changeEvalSet(deps, ctx, actor, params);
        return {
          data: { action: params.action, ...result },
          hint: "get_fix_eval_set reads the set; run_eval simulates the fix on it.",
        };
      },
    }),
    defineOperation({
      id: "dismiss_fix",
      domain: "writes",
      title: "Dismiss a drafted fix",
      description:
        "Dismiss a drafted tool change (a craft: fix) so it leaves the list and later readings do not draft it again. Other kinds are refused: a description rewrite is dismissed where it is applied. Returns the dismissed fix id.",
      keywords: ["dismiss fix", "reject a drafted change"],
      scope: "project",
      mutates: true,
      params: z.object({ ...projectScoped, fixId: fixIdParam }),
      async execute(ctx, params) {
        const model = await deps.loadProjectFixes(ctx.projectId);
        if (!model) throw notFound("project");
        const fix = findFix(model.open, params.fixId);
        if (!fix) throw notFound("open fix");
        if (fix.source !== "craft" || !fix.actions.dismiss) {
          throw new McpOperationError(
            "conflict",
            "Only a drafted tool change (a craft: fix) can be dismissed.",
            { reason: "not_dismissable" },
          );
        }
        const dismissed = await deps.dismissCraftProposal(ctx.projectId, fix.sourceId, deps.now());
        if (!dismissed)
          throw new McpOperationError(
            "conflict",
            "This fix was already dismissed or replaced by a newer reading.",
            { reason: "already_dismissed" },
          );
        await deps.trackServerEvent("tool_craft_proposal_dismissed", mcpEventContext(ctx), {
          object_action: "tool_craft_proposal_dismissed",
          proposal_id: fix.sourceId,
          fix_id: fix.id,
          surface: "mcp",
        });
        return { data: { fixId: fix.id, dismissed: true }, hint: "list_fixes no longer shows it." };
      },
    }),
  ];
}
