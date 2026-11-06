import { z } from "zod";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { invalidParams, McpOperationError, notFound } from "@/lib/mcp/errors";
import {
  experimentRef,
  fixRef,
  fixSource,
  insightIdOf,
  shipmentRef,
} from "@/lib/mcp/operations/loop/lineage";
import {
  type InsightView,
  loadInsight,
  loadOpenInsights,
  loadProjectFixes,
} from "@/lib/mcp/operations/loop/read";
import { recordLineage } from "@/lib/mcp/operations/loop/record-lineage";
import {
  EvalGateError,
  latestEvalOutcome,
  runSimulation,
  type SimulationOutcome,
} from "@/lib/mcp/operations/loop/simulation";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation, type OperationContext } from "@/lib/mcp/registry";
import { capRows, limitParam, TruncationTracker } from "@/lib/mcp/serialize";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException, trackServerEvent } from "@/lib/platform/telemetry";
import { EVAL_GATE_OFF_ERROR, evalGateEnabledForActor } from "@/lib/views/eval-gate/gate";
import type { FixDraftRow } from "@/lib/views/fix-drafts/schema";
import { latestFixDraft } from "@/lib/views/fix-drafts/store";
import {
  createFixExperiment,
  createFixShipment,
  getFixExperiment,
  listFixExperiments,
  listFixShipments,
  listProjectShipments,
  type ShippedFixRow,
} from "@/lib/views/fixes/loop-queries";
import type { FixExperimentRow, FixShipmentRow } from "@/lib/views/fixes/schema";
import { findFix } from "@/lib/views/fixes/select";
import { type FixShipped, shippedByFix, shippedFor } from "@/lib/views/fixes/shipped";
import type { Fix, FixesModel } from "@/lib/views/fixes/types";
import { fixSourceRef } from "@/lib/views/lineage/refs";
import type { LineageRef } from "@/lib/views/lineage/types";

/**
 * The improvement loop as tools (RC-43): Insights → Improve → Ship, so an
 * agent connected over MCP can walk from a trace to a shipped fix without the
 * console. Monitor is the existing trace and health tools.
 *
 * Every insight, fix, eval, experiment and shipment carries `source`, a
 * `LineageRef` one step back (`lib/lineage`), and the tools that are cheap to
 * walk further return `chain`, oldest first (`[trace, insight, fix, …,
 * shipment]`), the order RC-45's `chainOf` and the Ship page use. Which stage each tool belongs to
 * lives in `lib/mcp/stages.ts`, not here, so regrouping the stages changes
 * metadata and never a tool.
 *
 * Behind `FF_MCP_LOOP` (see `lib/mcp/loop-flag.ts`): off, none of these is
 * listed. `run_eval` and `get_eval` also need `FF_EVAL_GATE`; off, they refuse
 * with `forbidden` (`eval_gate_off`).
 *
 * Owned (ADR-0030): seven tools. The task tools (`list_tasks`, `get_task`) and
 * a fix's task simulations land with the task loop; until then every fix is
 * simulated on its own eval set. A fix's `draft` is its newest fix draft while
 * the eval gate is on (`FF_EVAL_GATE`), else null.
 */
export interface LoopOperationDeps {
  loadOpenInsights: (projectId: string) => Promise<InsightView[]>;
  loadInsight: (projectId: string, insightId: string) => Promise<InsightView | null>;
  loadProjectFixes: (projectId: string) => Promise<FixesModel | null>;
  runSimulation: typeof runSimulation;
  /** The fix's newest simulation, queued, running or done (RC-70). */
  latestEval: (
    projectId: string,
    fix: Pick<Fix, "id" | "short">,
  ) => Promise<SimulationOutcome | null>;
  /**
   * `cloud-eval-gate` for the caller in the project's organization
   * (`evalGateEnabledForActor`): an OAuth user as the console decides them, an
   * API key as `project:<id>` with the organization's properties.
   */
  evalGateEnabled: (projectId: string, actor: string) => Promise<boolean>;
  /** The fix's newest draft (`lib/views/fix-drafts`), read only while the eval gate is on. */
  latestFixDraft: (projectId: string, fixId: string) => ReturnType<typeof latestFixDraft>;
  recordLineage: typeof recordLineage;
  createFixExperiment: typeof createFixExperiment;
  getFixExperiment: typeof getFixExperiment;
  listFixExperiments: typeof listFixExperiments;
  createFixShipment: typeof createFixShipment;
  listFixShipments: typeof listFixShipments;
  /** The project's shipments, for list_fixes to mark each shipped fix (RC-72). */
  listProjectShipments: (projectId: string) => ReturnType<typeof listProjectShipments>;
  trackServerEvent: typeof trackServerEvent;
}

export const defaultLoopDeps: LoopOperationDeps = {
  loadOpenInsights,
  loadInsight,
  loadProjectFixes,
  runSimulation,
  latestEval: (projectId, fix) => latestEvalOutcome(projectId, fix),
  evalGateEnabled: (projectId, actor) => evalGateEnabledForActor(projectId, actor),
  latestFixDraft: (projectId, fixId) => latestFixDraft(projectId, fixId),
  recordLineage,
  createFixExperiment,
  getFixExperiment,
  listFixExperiments,
  createFixShipment,
  listFixShipments,
  listProjectShipments: (projectId) => listProjectShipments(projectId),
  trackServerEvent,
};

const fixIdParam = z
  .string()
  .min(1)
  .max(200)
  .describe(
    "A fix id from list_fixes or get_fix, e.g. issue:<uuid>, craft:<uuid>, rewrite:<uuid>.",
  );

const insightIdParam = z.string().uuid().describe("An insight id from list_insights.");

const ARM = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const EXPERIMENT_NAME = /^[a-z0-9][a-z0-9._-]{1,79}$/;

/** Who acted, as the stored rows and events name them. */
function actorOf(auth: McpAuthContext, projectId: string): string {
  return auth.kind === "api-key" ? `project:${projectId}` : auth.externalUserId;
}

function eventContext(ctx: OperationContext) {
  const orgId = ctx.organizationId ? { orgId: ctx.organizationId } : {};
  return ctx.auth.kind === "api-key"
    ? { projectId: ctx.projectId, ...orgId }
    : { externalId: ctx.auth.externalUserId, projectId: ctx.projectId, ...orgId };
}

async function requireFixes(deps: LoopOperationDeps, projectId: string): Promise<FixesModel> {
  const model = await deps.loadProjectFixes(projectId);
  if (!model) throw notFound("project");
  return model;
}

/** A fix by its id, an id merged into it, or `issue:<insight id>`; open or applied. */
async function requireFix(deps: LoopOperationDeps, projectId: string, id: string): Promise<Fix> {
  const model = await requireFixes(deps, projectId);
  const fix = findFix([...model.open, ...model.applied], id);
  if (!fix) throw notFound("fix");
  return fix;
}

/** A fix's shipped state as the tools report it: its newest shipment's version and time, or null (RC-72). */
const logger = getLogger("mcp/loop");

/**
 * The project's shipments, or none when the read fails: `shipped` is extra to
 * a fix, so a failed read reports it as null rather than failing the tool.
 */
async function readProjectShipments(
  deps: LoopOperationDeps,
  projectId: string,
): Promise<ShippedFixRow[]> {
  try {
    return await deps.listProjectShipments(projectId);
  } catch (err) {
    logger.error({ err, project_id: projectId }, "fix shipments read failed");
    reportServerException(err, `project:${projectId}`, {
      project_id: projectId,
      operation: "mcp_fix_shipments",
    });
    return [];
  }
}

function shippedView(shipped: FixShipped | null) {
  return shipped
    ? {
        version: shipped.version,
        shippedAt: shipped.shippedAt,
        shipmentId: shipped.shipmentId,
        href: shipped.href,
      }
    : null;
}

function fixRow(
  projectId: string,
  fix: Fix,
  tracker: TruncationTracker,
  shipped: FixShipped | null,
  draft: FixDraftRow | null,
) {
  return {
    id: fix.id,
    title: fix.title,
    why: tracker.text(fix.why, 400),
    kind: fix.kind,
    kindLabel: fix.kindLabel,
    status: fix.status,
    effect: fix.effect
      ? { value: fix.effect.value, detail: fix.effect.detail, basis: fix.effect.basis }
      : null,
    evidence: fix.evidence
      ? { strength: fix.evidence.strength, detail: fix.evidence.detail }
      : null,
    insightIds: fix.issues.map((issue) => issue.id),
    taskIds: [...new Set(fix.subject.tasks.map((task) => task.id))],
    draft: draft
      ? {
          id: draft.id,
          status: draft.status,
          origin: draft.origin,
          change: draft.change,
          createdAt: draft.createdAt.toISOString(),
        }
      : null,
    tools: fix.subject.tools.map((tool) => tool.label),
    href: fixRef(projectId, fix).href,
    source: fixSource(projectId, fix),
    shipped: shippedView(shipped),
  };
}

/** The change itself, in the form its engine gives it. */
function changeOf(fix: Fix, tracker: TruncationTracker) {
  const detail = fix.detail;
  switch (detail.source) {
    case "rewrite":
      return {
        type: "searchable_description",
        toolId: detail.row.toolId,
        toolName: detail.row.toolName,
        proposedSearchableDescription: tracker.text(detail.row.proposed, 1_000),
        rationale: tracker.text(detail.row.rationale, 600),
        applyWith: "set_catalog_override",
      };
    case "craft":
      return {
        type: "tool_change",
        steps: detail.change,
        replay: detail.replay,
        definitions: detail.crafted.map((crafted) => ({
          name: crafted.name,
          json: tracker.text(crafted.json, 2_000),
        })),
      };
    case "issue":
    case "intent":
      return { type: "agent_change", steps: detail.changes, caveat: detail.caveat };
  }
}

function experimentView(projectId: string, row: FixExperimentRow, fixSourceRef: LineageRef) {
  return {
    id: row.id,
    name: row.name,
    fixId: row.fixId,
    insightId: row.insightId,
    arms: { baseline: row.baselineArm, candidate: row.candidateArm },
    trafficPercent: row.trafficPercent,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    href: experimentRef(projectId, row).href,
    source: fixSourceRef,
  };
}

function shipmentView(row: FixShipmentRow, source: LineageRef) {
  return {
    id: row.id,
    fixId: row.fixId,
    insightId: row.insightId,
    experimentId: row.experimentId,
    version: row.version,
    notes: row.notes,
    shippedAt: row.shippedAt.toISOString(),
    source,
  };
}

/**
 * trace or metric → insight → fix, oldest first (as `chainOf` returns it), as
 * far as is known with one read.
 */
async function fixChain(
  deps: LoopOperationDeps,
  projectId: string,
  fix: Fix,
): Promise<LineageRef[]> {
  const chain = [fixSource(projectId, fix), fixRef(projectId, fix)];
  const insightId = insightIdOf(fix);
  if (insightId) {
    const insight = await deps.loadInsight(projectId, insightId);
    if (insight) chain.unshift(insight.source);
  }
  return chain;
}

/**
 * Record where the fix came from in the lineage spine before linking anything
 * to it. The spine derives an issue fix's insight on its own, but a craft or
 * rewrite fix is tied to its insight by Fixes (by tool or task), which the
 * spine cannot see; without this link Ship's chain would stop at the fix.
 *
 * Only a source the fix names (an insight, intent or task) is recorded, never
 * `fixSource`'s metric fallback: a recorded link wins over a derived one, so a
 * stored metric would hide the insight the spine derives once one names the
 * fix's proposal.
 */
async function recordFixSource(
  deps: LoopOperationDeps,
  ctx: OperationContext,
  fix: Fix,
  self: LineageRef,
) {
  const source = fixSourceRef(ctx.projectId, fix);
  if (!source) return;
  await deps.recordLineage({
    projectId: ctx.projectId,
    object: self,
    source,
    actor: eventContext(ctx),
  });
}

/** The refusal `run_eval` returns for a fix with nothing to simulate (RC-77). */
export function nothingToSimulateError(reason: string): McpOperationError {
  return new McpOperationError(
    "conflict",
    `This fix has nothing to simulate yet, so no eval was queued. ${reason}`,
    { reason: "nothing_to_simulate" },
  );
}

/**
 * A fix id the eval gate does not know in this project is the same not-found
 * as anywhere else; a fix with nothing to simulate is refused with why (RC-77).
 */
async function simulate(
  deps: LoopOperationDeps,
  ...args: Parameters<LoopOperationDeps["runSimulation"]>
) {
  try {
    return await deps.runSimulation(...args);
  } catch (err) {
    if (err instanceof EvalGateError)
      throw err.code === "nothing-to-simulate"
        ? nothingToSimulateError(err.message)
        : notFound("fix");
    throw err;
  }
}

/** How often an agent should look again while a simulation runs. */
const EVAL_POLL_SECONDS = 20;

/** The eval gate is decided for this caller in the project's organization (RC-46/RC-61): off, nothing is simulated or read. */
async function requireEvalGate(deps: LoopOperationDeps, ctx: OperationContext): Promise<string> {
  const actor = actorOf(ctx.auth, ctx.projectId);
  if (!(await deps.evalGateEnabled(ctx.projectId, actor))) {
    throw new McpOperationError("forbidden", EVAL_GATE_OFF_ERROR, { reason: "eval_gate_off" });
  }
  return actor;
}

/**
 * A simulation as `run_eval` and `get_eval` report it, with the hint for what
 * to do next. Simulated means historical runs were replayed with the fix
 * applied and the replay is trusted; a kind the gate cannot simulate, a set
 * with no runs, or a replay that didn't re-enact them (RC-69) has no before
 * and after.
 */
function evalData(outcome: SimulationOutcome, fixId: string, self: LineageRef) {
  const live = outcome.status === "queued" || outcome.status === "running";
  const unreliable = outcome.verdict === "unreliable";
  const simulated = outcome.status === "completed" && outcome.nSimulated > 0 && !unreliable;
  const methods = outcome.methods ?? null;
  const hint = live
    ? `The simulation runs in the background. Call get_eval with this fixId about every ${EVAL_POLL_SECONDS} seconds until status is completed or failed. Do not call run_eval again: it returns this same simulation while it runs.`
    : unreliable
      ? "The replay didn't re-enact the recorded runs (see fidelity and reasons), so there is no verdict. Do not report a before and after for this fix."
      : simulated
        ? "create_experiment to try it on live traffic, or mark_fix_shipped once it is released."
        : outcome.status === "failed"
          ? "The simulation failed. run_eval again to retry it."
          : "Nothing was replayed, so there is no before and after. Do not report this as a simulation.";
  return {
    eval: {
      id: outcome.eval.id,
      fixId,
      status: outcome.status,
      simulated,
      label: outcome.label,
      runs: outcome.nSimulated,
      cases: outcome.nCases,
      before: unreliable ? null : outcome.before,
      after: unreliable ? null : outcome.after,
      verdict: live ? "pending" : (outcome.verdict ?? "not_simulated"),
      fidelity: methods?.fidelity ?? null,
      reasons: methods?.reasons ?? [],
      error: outcome.error,
      href: outcome.href,
      source: self,
      ...(live ? { pollAfterSeconds: EVAL_POLL_SECONDS } : {}),
    },
    simulated,
    hint,
  };
}

export function loopReadOperations(deps: LoopOperationDeps = defaultLoopDeps): McpOperation[] {
  return [
    defineOperation({
      id: "list_insights",
      domain: "observability",
      title: "List insights",
      description:
        "The open findings about the agent, worst first, in the words Agent health shows: what went wrong, what it costs, what to do, and the trace or reading it came from (source). Follow one with get_fix. For catalog-level hints use get_improvement_signals.",
      keywords: ["list insights", "agent health", "findings", "what went wrong", "issues"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        kind: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe("Only insights of this kind, e.g. tool_errors."),
        limit: limitParam,
      }),
      async execute(ctx, params) {
        const tracker = new TruncationTracker();
        const all = await deps.loadOpenInsights(ctx.projectId);
        const matching = params.kind ? all.filter((insight) => insight.kind === params.kind) : all;
        const page = tracker.take(capRows(matching, params.limit));
        return {
          data: { count: matching.length, insights: page },
          truncated: tracker.value,
          hint:
            matching.length === 0
              ? "No open insights. Agent health reads closed turns; check list_traces and get_trace_health, and that the analysis has run."
              : "get_fix with an insightId returns the change that resolves it.",
        };
      },
    }),
    defineOperation({
      id: "list_fixes",
      domain: "improvement",
      title: "List fixes",
      description:
        "List proposed fixes with their effect, insightIds, taskIds, draft, source and shipped version. Filter by insightId or taskId. The draft is null when the eval gate is off. Call get_fix to read the change.",
      keywords: ["list fixes", "proposed changes", "fixes"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        insightId: insightIdParam.optional(),
        taskId: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Only fixes that affect this task id."),
        status: z.enum(["open", "applied", "all"]).default("open"),
        limit: limitParam,
      }),
      async execute(ctx, params) {
        const tracker = new TruncationTracker();
        const [model, shipments] = await Promise.all([
          requireFixes(deps, ctx.projectId),
          readProjectShipments(deps, ctx.projectId),
        ]);
        const shipped = shippedByFix(ctx.projectId, shipments);
        const pool =
          params.status === "open"
            ? model.open
            : params.status === "applied"
              ? model.applied
              : [...model.open, ...model.applied];
        const matching = pool.filter(
          (fix) =>
            (!params.insightId || fix.issues.some((issue) => issue.id === params.insightId)) &&
            (!params.taskId || fix.subject.tasks.some((task) => task.id === params.taskId)),
        );
        const page = tracker.take(capRows(matching, params.limit));
        const draftsEnabled = await deps.evalGateEnabled(
          ctx.projectId,
          actorOf(ctx.auth, ctx.projectId),
        );
        const fixes = await Promise.all(
          page.map(async (fix) =>
            fixRow(
              ctx.projectId,
              fix,
              tracker,
              shippedFor(shipped, fix),
              draftsEnabled ? await deps.latestFixDraft(ctx.projectId, fix.id) : null,
            ),
          ),
        );
        return {
          data: {
            count: matching.length,
            fixes,
            ...(model.failed.length > 0 ? { sourcesNotRead: model.failed } : {}),
          },
          truncated: tracker.value,
        };
      },
    }),
    defineOperation({
      id: "get_fix",
      domain: "improvement",
      title: "Get fix",
      description:
        "Read one fix with its change, taskIds, draft, evidence, experiments and shipments. The chain lists its sources in order. A ready draft supplies the change when the eval gate is on. Pass fixId or insightId. Call run_eval to simulate the fix.",
      keywords: ["get fix", "fix for an insight", "how do i fix"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        fixId: fixIdParam.optional(),
        insightId: insightIdParam.optional(),
      }),
      async execute(ctx, params) {
        const id = params.fixId ?? (params.insightId ? `issue:${params.insightId}` : null);
        if (!id)
          throw invalidParams("Pass fixId, or insightId for the fix that resolves that insight.");
        const tracker = new TruncationTracker();
        const fix = await requireFix(deps, ctx.projectId, id);
        const [chain, experiments, shipments, projectShipments] = await Promise.all([
          fixChain(deps, ctx.projectId, fix),
          deps.listFixExperiments(ctx.projectId, fix.id),
          deps.listFixShipments(ctx.projectId, fix.id),
          // As list_fixes reads it, so a shipment under an id merged into the fix counts here too.
          readProjectShipments(deps, ctx.projectId),
        ]);
        const draft = (await deps.evalGateEnabled(ctx.projectId, actorOf(ctx.auth, ctx.projectId)))
          ? await deps.latestFixDraft(ctx.projectId, fix.id)
          : null;
        const self = fixRef(ctx.projectId, fix);
        return {
          data: {
            fix: {
              ...fixRow(
                ctx.projectId,
                fix,
                tracker,
                shippedFor(shippedByFix(ctx.projectId, [...shipments, ...projectShipments]), fix),
                draft,
              ),
              short: fix.short,
              change: draft?.status === "ready" ? draft.change : changeOf(fix, tracker),
              copy: fix.actions.copy
                ? {
                    label: fix.actions.copy.label,
                    text: tracker.text(fix.actions.copy.text, 4_000),
                  }
                : null,
              issues: fix.issues.map((issue) => ({
                id: issue.id,
                title: issue.title,
                claim: issue.claim,
                href: issue.href,
              })),
              appliedAt: fix.appliedAt,
            },
            chain,
            experiments: experiments.map((row) => experimentView(ctx.projectId, row, self)),
            shipments: shipments.map((row) => shipmentView(row, self)),
          },
          truncated: tracker.value,
          hint: "run_eval checks the fix on historical runs; then create_experiment, or mark_fix_shipped once it is in a release.",
        };
      },
    }),
    defineOperation({
      id: "get_eval",
      domain: "improvement",
      title: "Get eval of a fix",
      description:
        "Read the latest simulation of a fix without starting one. Poll this tool after run_eval. The eval is null before the first simulation.",
      keywords: ["get eval", "eval result", "simulation status"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped, fixId: fixIdParam }),
      async execute(ctx, params) {
        const fix = await requireFix(deps, ctx.projectId, params.fixId);
        await requireEvalGate(deps, ctx);
        const outcome = await deps.latestEval(ctx.projectId, fix);
        if (!outcome)
          return {
            data: { eval: null },
            hint: "This fix was never simulated: run_eval queues a simulation.",
          };
        const { eval: view, hint } = evalData(outcome, fix.id, fixRef(ctx.projectId, fix));
        return { data: { eval: view }, hint };
      },
    }),
  ];
}

export function loopWriteOperations(deps: LoopOperationDeps = defaultLoopDeps): McpOperation[] {
  return [
    defineOperation({
      id: "run_eval",
      domain: "writes",
      title: "Run eval on a fix",
      description:
        "Queue a simulation of a fix on the project's own historical runs. Poll get_eval while it is pending. Call mark_fix_shipped when the fix is live.",
      keywords: ["run eval", "simulate a fix", "before and after"],
      scope: "project",
      mutates: true,
      params: z.object({ ...projectScoped, fixId: fixIdParam }),
      async execute(ctx, params) {
        const fix = await requireFix(deps, ctx.projectId, params.fixId);
        const actor = await requireEvalGate(deps, ctx);
        // RC-70: queued for the job worker, never run inline, so a slow
        // simulation can't outlast the MCP request. A simulation already
        // running for this fix is returned as it is.
        const outcome = await simulate(deps, fix.id, {
          projectId: ctx.projectId,
          trigger: "mcp",
          actor,
          background: true,
        });
        const self = fixRef(ctx.projectId, fix);
        const { eval: view, simulated, hint } = evalData(outcome, fix.id, self);

        await deps.trackServerEvent("fix_eval_run", eventContext(ctx), {
          object_action: "fix_eval_run",
          fix_id: fix.id,
          simulated,
          verdict: view.verdict,
          status: outcome.status,
          runs: outcome.nSimulated,
          surface: "mcp",
        });

        return {
          data: {
            eval: view,
            chain: [
              ...(await fixChain(deps, ctx.projectId, fix)),
              { ...outcome.eval, href: outcome.eval.href ?? outcome.href },
            ],
          },
          hint,
        };
      },
    }),
    defineOperation({
      id: "create_experiment",
      domain: "writes",
      title: "Create experiment for a fix",
      description:
        "Declare an A/B experiment for a fix: a name and two arms the agent's runtime tags its spans with (ratel.experiment.id and ratel.experiment.arm), so the experiment pages compare them. Creates a record and its lineage link to the fix; does not change the agent. chain is oldest first: trace, insight, fix, experiment.",
      keywords: ["start experiment", "a/b test", "experiment"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        fixId: fixIdParam,
        name: z
          .string()
          .regex(EXPERIMENT_NAME, "lowercase letters, digits, '.', '_' or '-'")
          .optional()
          .describe("The ratel.experiment.id value. Defaults to fix-<kind>-<short id>."),
        baselineArm: z.string().regex(ARM).default("baseline"),
        candidateArm: z.string().regex(ARM).default("fix"),
        trafficPercent: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(50)
          .describe("Share of traffic on the candidate arm."),
      }),
      async execute(ctx, params) {
        if (params.baselineArm === params.candidateArm) {
          throw invalidParams("baselineArm and candidateArm must differ.");
        }
        const fix = await requireFix(deps, ctx.projectId, params.fixId);
        const name = params.name ?? defaultExperimentName(fix);
        const created = await deps.createFixExperiment({
          projectId: ctx.projectId,
          fixId: fix.id,
          insightId: insightIdOf(fix),
          name,
          baselineArm: params.baselineArm,
          candidateArm: params.candidateArm,
          trafficPercent: params.trafficPercent,
          createdBy: actorOf(ctx.auth, ctx.projectId),
        });
        if ("duplicate" in created) {
          throw invalidParams(
            `This project already has an experiment named "${name}". Pass another name.`,
          );
        }
        const row = created.row;
        const self = fixRef(ctx.projectId, fix);

        await recordFixSource(deps, ctx, fix, self);
        await deps.recordLineage({
          projectId: ctx.projectId,
          object: experimentRef(ctx.projectId, row),
          source: self,
          actor: eventContext(ctx),
        });
        await deps.trackServerEvent("fix_experiment_created", eventContext(ctx), {
          object_action: "fix_experiment_created",
          fix_id: fix.id,
          experiment_id: row.id,
          traffic_percent: row.trafficPercent,
          surface: "mcp",
        });

        return {
          data: {
            experiment: experimentView(ctx.projectId, row, self),
            runtime: {
              spanAttributes: {
                "ratel.experiment.id": row.name,
                "ratel.experiment.arm": [row.baselineArm, row.candidateArm],
              },
              instructions: `Send ${row.trafficPercent}% of runs with the fix applied and ratel.experiment.arm=${row.candidateArm}, the rest unchanged with ratel.experiment.arm=${row.baselineArm}, all with ratel.experiment.id=${row.name}.`,
            },
            chain: [
              ...(await fixChain(deps, ctx.projectId, fix)),
              experimentRef(ctx.projectId, row),
            ],
          },
          hint: "Once the release carrying the fix is out, mark_fix_shipped with this experimentId.",
        };
      },
    }),
    defineOperation({
      id: "mark_fix_shipped",
      domain: "writes",
      title: "Mark fix shipped",
      description:
        "Record that a fix is live in a version of the agent, linked to the fix, the insight it resolves and, optionally, the experiment that tested it. It then shows on the project's Ship page. Returns the full lineage chain, oldest first: trace, insight, fix, experiment (when given), shipment. Records only; deploys nothing.",
      keywords: ["mark shipped", "released", "ship a fix"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        fixId: fixIdParam,
        version: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .describe(
            "The agent version or release that carries the fix, e.g. v1.4.2 or a commit sha.",
          ),
        experimentId: z
          .string()
          .uuid()
          .optional()
          .describe("The experiment from create_experiment that tested it."),
        notes: z.string().max(1_000).optional(),
      }),
      async execute(ctx, params) {
        const fix = await requireFix(deps, ctx.projectId, params.fixId);
        let experiment: FixExperimentRow | null = null;
        if (params.experimentId) {
          experiment = await deps.getFixExperiment(ctx.projectId, params.experimentId);
          if (!experiment || experiment.fixId !== fix.id) throw notFound("experiment for this fix");
        }
        const insightId = insightIdOf(fix);
        const row = await deps.createFixShipment({
          projectId: ctx.projectId,
          fixId: fix.id,
          insightId,
          experimentId: experiment?.id ?? null,
          version: params.version,
          notes: params.notes ?? null,
          shippedBy: actorOf(ctx.auth, ctx.projectId),
        });

        const self = fixRef(ctx.projectId, fix);
        const source = experiment ? experimentRef(ctx.projectId, experiment) : self;
        await recordFixSource(deps, ctx, fix, self);
        await deps.recordLineage({
          projectId: ctx.projectId,
          object: shipmentRef(ctx.projectId, row),
          source,
          actor: eventContext(ctx),
        });
        await deps.trackServerEvent("fix_shipped", eventContext(ctx), {
          object_action: "fix_shipped",
          fix_id: fix.id,
          shipment_id: row.id,
          has_insight: insightId !== null,
          has_experiment: experiment !== null,
          surface: "mcp",
        });

        return {
          data: {
            shipment: {
              ...shipmentView(row, source),
              href: shipmentRef(ctx.projectId, row).href,
              fix: self,
              insight: insightId ? fixSource(ctx.projectId, fix) : null,
            },
            chain: [
              ...(await fixChain(deps, ctx.projectId, fix)),
              ...(experiment ? [experimentRef(ctx.projectId, experiment)] : []),
              shipmentRef(ctx.projectId, row),
            ],
          },
        };
      },
    }),
  ];
}

/** `fix-<kind>-<first 8 of its id>`, e.g. fix-issue-3f2a91c0. */
export function defaultExperimentName(fix: Pick<Fix, "id" | "source" | "sourceId">): string {
  const short =
    fix.sourceId
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 8)
      .toLowerCase() || "x";
  return `fix-${fix.source}-${short}`;
}
