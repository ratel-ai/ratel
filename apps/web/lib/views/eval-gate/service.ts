import { and, eq, inArray } from "drizzle-orm";
import { loadToolCorpus } from "@/lib/ingest/runtime-catalog/inventory";
import { runtimeCatalogEntries } from "@/lib/ingest/runtime-catalog/schema";
import { getDb } from "@/lib/platform/db/client";
import { currentLogContext, getLogger } from "@/lib/platform/logger";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { withProjectLogContext } from "@/lib/platform/project-log-context";
import type { ServerEventContext } from "@/lib/platform/telemetry";
import { reportServerException } from "@/lib/platform/telemetry";
import type { CorpusEntry } from "@/lib/readings/decisions/judge";
import { traceTopics } from "@/lib/readings/topics/schema";
import { traceSignals } from "@/lib/readings/trace-signals/schema";
import { matchQualityProposals } from "@/lib/synthesis/match-quality/schema";
import { toolCraftProposals } from "@/lib/synthesis/tool-crafter/schema";
import { loadModelCalls } from "@/lib/views/eval-gate/calls";
import { parseChange } from "@/lib/views/eval-gate/change";
import { defaultExpected } from "@/lib/views/eval-gate/defaults";
import { SIMULATE_FIX_EVAL_JOB } from "@/lib/views/eval-gate/job-kind";
import { methodForKind, nothingToSimulate, replayGap } from "@/lib/views/eval-gate/method";
import {
  DAILY_ORG_BUDGET_USD,
  type EvalModels,
  resolveEvalModels,
} from "@/lib/views/eval-gate/models";
import { createRanker } from "@/lib/views/eval-gate/ranker";
import {
  type EvalDb,
  findRun,
  loadEvidenceTurnIds,
  loadRuns,
  selectHoldoutRuns,
  traceIdsOf,
} from "@/lib/views/eval-gate/runs";
import type { FixEvalRunRow, FixEvalSetRow } from "@/lib/views/eval-gate/schema";
import { summarize } from "@/lib/views/eval-gate/score";
import { resolveFixChange } from "@/lib/views/eval-gate/seams";
import { affects } from "@/lib/views/eval-gate/simulate";
import { simulateCases } from "@/lib/views/eval-gate/simulation";
import {
  addCases,
  completeEvalRun,
  createEvalSet,
  failEvalRun,
  getEvalRun,
  getEvalSet,
  getEvalSetById,
  isTimedOut,
  listCases,
  listEvalRuns,
  listSetsWithLatestRun,
  type NewCase,
  organizationModelSpendSince,
  parseEvidence,
  parseMethods,
  parseSpend,
  parseStatus,
  parseTally,
  parseVerdict,
  queueEvalRun,
  setRunJob,
  startEvalRun,
  updateEvalSetChange,
} from "@/lib/views/eval-gate/store";
import type {
  CaseRole,
  EvalBadge,
  EvalCase,
  FixChange,
  SimMethod,
  SimulationOutcome,
  SimulationSummary,
  ToolDef,
} from "@/lib/views/eval-gate/types";
import { evalHref, simulatedLabel } from "@/lib/views/eval-gate/view";
import type { FixKind } from "@/lib/views/fixes/kinds";
import { loadFixes } from "@/lib/views/fixes/load";
import { findFix } from "@/lib/views/fixes/select";
import type { Fix } from "@/lib/views/fixes/types";
import { evalRef as lineageEvalRef } from "@/lib/views/lineage/refs";
import { recordLineage } from "@/lib/views/lineage/resolve";
import type { LineageRef } from "@/lib/views/lineage/types";
import { parseLineageRef } from "@/lib/views/lineage/types";

/**
 * The eval gate's service: an eval set per fix built from the project's own
 * runs, and simulations of the fix over it. `runSimulation` is the one entry
 * point other surfaces call (Fixes, the eval page, RC-43's MCP `run_eval`).
 *
 * A simulation reads stored runs and the catalog and calls nothing in the
 * customer's environment. Retrieval fixes are re-ranked in-process with the
 * SDK's BM25 (`simulate.ts`); behavioral fixes are replayed by a model and the
 * person's criteria judged by one (RC-61), all under `cloud-eval-gate`, within
 * a per-eval cap and the organization's daily budget (`DAILY_ORG_BUDGET_USD`).
 */

const logger = getLogger("eval-gate/service");

/** Runs a new set starts with (the holdout, RC-61). */
export const DEFAULT_TARGET_RUNS = 20;
/** The insight's own runs a set keeps, apart from the holdout, for comparison (RC-61). */
export const EVIDENCE_RUNS = 5;
const DAY_MS = 24 * 60 * 60_000;

export interface FixContext {
  projectId: string;
  fix: Fix;
}

export interface EvalGateDeps {
  db: EvalDb;
  /** The fix as Fixes shows it; null when the project has no such fix (any more). */
  loadFix: (projectId: string, fixId: string) => Promise<FixContext | null>;
  loadCorpus: (projectId: string) => Promise<CorpusEntry[]>;
  /** Queue the background job for a simulation; returns the job id. */
  enqueue: (projectId: string, runId: string) => Promise<string | null>;
  /** Record the eval → fix link in the lineage spine (RC-45's `recordLineage`). */
  recordLineage: (input: Parameters<typeof recordLineage>[0]) => Promise<LineageRef>;
  /** RC-61: the models a simulation may call (the deployment's by default; stand-ins in tests). */
  models?: EvalModels;
  /** RC-61: caps, defaulting to the environment's. */
  replayBudgetUsd?: number;
  judgeBudgetUsd?: number;
  /** What one organization's simulations may spend on models in 24 hours (`DAILY_ORG_BUDGET_USD`). */
  dailyBudgetUsd?: number;
  maxSteps?: number;
  now?: () => Date;
}

async function enqueueSimulation(projectId: string, runId: string): Promise<string | null> {
  // Imported here: the job queue pulls in every handler, and this module is one of them.
  const { enqueueForProjectId } = await import("@/lib/jobs/route-helpers");
  const result = await enqueueForProjectId(projectId, SIMULATE_FIX_EVAL_JOB, { runId });
  const body = result.body as { jobId?: unknown };
  return typeof body.jobId === "string" ? body.jobId : null;
}

function withDeps(partial: Partial<EvalGateDeps> = {}): EvalGateDeps {
  const db = partial.db ?? getDb();
  return {
    db,
    loadFix: partial.loadFix ?? loadFixContext,
    loadCorpus: partial.loadCorpus ?? ((projectId) => loadToolCorpus(projectId, db)),
    enqueue: partial.enqueue ?? enqueueSimulation,
    recordLineage: partial.recordLineage ?? ((input) => recordLineage(input, db)),
    ...(partial.models ? { models: partial.models } : {}),
    ...(partial.replayBudgetUsd !== undefined ? { replayBudgetUsd: partial.replayBudgetUsd } : {}),
    ...(partial.judgeBudgetUsd !== undefined ? { judgeBudgetUsd: partial.judgeBudgetUsd } : {}),
    ...(partial.dailyBudgetUsd !== undefined ? { dailyBudgetUsd: partial.dailyBudgetUsd } : {}),
    ...(partial.maxSteps !== undefined ? { maxSteps: partial.maxSteps } : {}),
    ...(partial.now ? { now: partial.now } : {}),
  };
}

/* - The fix ------------------------------------------------------------------ */

/** The fix with this id (or alias) in the project, read as Fixes reads it. */
export async function loadFixContext(projectId: string, fixId: string): Promise<FixContext | null> {
  const organization = await getOrganizationByProjectId(projectId);
  if (!organization) return null;
  const model = await loadFixes({ projectId, organization });
  const fix = findFix([...model.open, ...model.applied], fixId);
  return fix ? { projectId, fix } : null;
}

/** The project a fix id belongs to, from its source row; null when it names nothing (or, for an intent, more than one project). */
export async function resolveFixProject(
  fixId: string,
  db: EvalDb = getDb(),
): Promise<string | null> {
  const [source, ...rest] = fixId.split(":");
  const id = rest.join(":");
  if (!id) return null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  if (source === "craft" && uuid) {
    const [row] = await db
      .select({ projectId: toolCraftProposals.projectId })
      .from(toolCraftProposals)
      .where(eq(toolCraftProposals.id, id))
      .limit(1);
    return row?.projectId ?? null;
  }
  if (source === "rewrite" && uuid) {
    const [row] = await db
      .select({ projectId: matchQualityProposals.projectId })
      .from(matchQualityProposals)
      .where(eq(matchQualityProposals.id, id))
      .limit(1);
    return row?.projectId ?? null;
  }
  if (source === "issue" && uuid) {
    const [row] = await db
      .select({ projectId: traceSignals.projectId })
      .from(traceSignals)
      .where(eq(traceSignals.id, id))
      .limit(1);
    return row?.projectId ?? null;
  }
  if (source === "intent") {
    const rows = await db
      .select({ projectId: traceTopics.projectId })
      .from(traceTopics)
      .where(eq(traceTopics.topicId, id))
      .limit(2);
    return rows.length === 1 ? rows[0]!.projectId : null;
  }
  return null;
}

/** The insight a fix came from (one step back in the lineage chain): its worst issue, else its intent. */
export function fixSource(fix: Pick<Fix, "issues" | "intent" | "subject">): LineageRef | null {
  const issue = fix.issues[0];
  if (issue)
    return {
      stage: "insights",
      kind: "insight",
      id: issue.id,
      label: issue.title,
      href: issue.href,
    };
  const topic = fix.intent ?? fix.subject.topics[0];
  if (topic)
    return {
      stage: "insights",
      kind: "intent",
      id: topic.id,
      label: topic.label,
      href: topic.href,
    };
  return null;
}

export function fixRef(projectId: string, fix: Pick<Fix, "id" | "short">): LineageRef {
  return {
    stage: "improve",
    kind: "fix",
    id: fix.id,
    label: fix.short,
    href: `/project/${encodeURIComponent(projectId)}/improvement/fixes?peek=${encodeURIComponent(fix.id)}`,
  };
}

/** The eval as a lineage ref: its set id, opening on the fix's eval page. */
function evalRef(
  projectId: string,
  set: Pick<FixEvalSetRow, "id" | "fixId" | "title">,
): LineageRef {
  return lineageEvalRef(projectId, set.id, set.fixId, `Eval: ${set.title}`);
}

/** Who asked, as `trackServerEvent` names them: a Clerk id, `project:<id>` for an API key, `system:<name>`. */
function actorContext(actor: string, projectId: string): ServerEventContext {
  if (actor.startsWith("project:"))
    return { projectId: actor.slice("project:".length) || projectId };
  if (actor.startsWith("system:")) return { distinctId: actor, projectId };
  return { externalId: actor, projectId };
}

/**
 * Tell the lineage spine the eval came from its fix (one `lineage_links` row
 * per eval set, refreshed on each simulation), so `chainOf` walks an eval back
 * to the run. A failure here never fails the simulation.
 */
async function recordEvalLineage(
  projectId: string,
  fix: Pick<Fix, "id" | "short">,
  set: FixEvalSetRow,
  actor: string,
  deps: EvalGateDeps,
) {
  try {
    await deps.recordLineage({
      projectId,
      object: evalRef(projectId, set),
      source: fixRef(projectId, fix),
      actor: actorContext(actor, projectId),
    });
  } catch (err) {
    logger.error({ err, project_id: projectId, set_id: set.id }, "fix eval lineage link failed");
    reportServerException(err, `project:${projectId}`, {
      operation: "fix_eval_lineage",
      project_id: projectId,
    });
  }
}

/* - The eval set ------------------------------------------------------------- */

/** New cases for these runs, each with its drafted expected outcome. */
async function draftCases(
  projectId: string,
  candidates: readonly { turnId: string; origin: NewCase["origin"]; originRef: string | null }[],
  fixKind: FixKind,
  change: FixChange,
  fixTools: readonly string[],
  db: EvalDb,
): Promise<NewCase[]> {
  const runs = await loadRuns(
    projectId,
    candidates.map((candidate) => candidate.turnId),
    db,
  );
  return candidates.flatMap((candidate) => {
    const run = runs.get(candidate.turnId);
    if (!run) return [];
    return [
      {
        ...candidate,
        traceId: run.traceId,
        expected: defaultExpected(run, fixKind, change, fixTools),
      },
    ];
  });
}

/**
 * The fix's eval set, made on first use from the project's runs (the issue's
 * evidence first, then runs of its tools, then its task's). An existing set is
 * left as the person edited it; only its change is refreshed from the fix.
 */
export async function ensureEvalSet(
  ctx: FixContext,
  actor: string,
  partial?: Partial<EvalGateDeps>,
): Promise<{ set: FixEvalSetRow; created: boolean }> {
  const deps = withDeps(partial);
  const { projectId, fix } = ctx;
  const { change } = await resolveFixChange(projectId, fix, {
    db: deps.db,
    actor,
  });
  const evidenceTurnIds = await loadEvidenceTurnIds(
    projectId,
    fix.issues.map((issue) => issue.id),
    deps.db,
  );
  const existing = await getEvalSet(projectId, fix.id, deps.db);
  if (existing) {
    // Written only on a real difference: a bump would mark the last simulation stale.
    const updated = await updateEvalSetChange(
      existing.id,
      change,
      fix.short,
      deps.db,
      evidenceTurnIds,
    );
    return { set: updated ?? existing, created: false };
  }
  const { set, created } = await createEvalSet(
    {
      projectId,
      fixId: fix.id,
      fixKind: fix.kind,
      title: fix.short,
      change,
      source: fixSource(fix),
      createdBy: actor,
      targetRuns: DEFAULT_TARGET_RUNS,
      evidenceTurnIds,
    },
    deps.db,
  );
  if (created) await topUpEvalSet(set, fix, deps);
  return { set, created };
}

/** A run's part in its set: the insight's evidence (scored apart) or the holdout (RC-61). */
export function roleOf(
  item: Pick<EvalCase, "origin" | "turnId">,
  evidence: ReadonlySet<string>,
): CaseRole {
  return item.origin === "issue" || evidence.has(item.turnId) ? "evidence" : "holdout";
}

/**
 * Fill the set's holdout up to its target with runs it doesn't hold yet, the
 * runs the change touches first, then keep up to `EVIDENCE_RUNS` of the
 * insight's own runs beside them (RC-61). Returns how many were added.
 */
export async function topUpEvalSet(
  set: FixEvalSetRow,
  fix: Fix,
  partial?: Partial<EvalGateDeps>,
): Promise<number> {
  const deps = withDeps(partial);
  const cases = await listCases(set.id, deps.db);
  const evidence = new Set(set.evidenceTurnIds ?? []);
  const holdoutCount = cases.filter((item) => roleOf(item, evidence) === "holdout").length;
  const evidenceCount = cases.length - holdoutCount;
  const room = Math.max(0, set.targetRuns - holdoutCount);
  const evidenceRoom = Math.max(0, EVIDENCE_RUNS - evidenceCount);
  if (room === 0 && evidenceRoom === 0) return 0;
  const change = parseChange(set.change);
  const tools = fix.subject.tools.map((tool) => tool.id);
  const selection = await selectHoldoutRuns(
    {
      projectId: set.projectId,
      issueIds: fix.issues.map((issue) => issue.id),
      tools: [
        ...new Set([
          ...tools,
          ...Object.keys(change.patches),
          ...change.hide,
          ...change.collapse,
          ...change.skillSteps,
        ]),
      ],
      tasks: fix.subject.tasks.map((task) => task.id),
      pool: room * 3,
      evidenceLimit: evidenceRoom,
      exclude: new Set(cases.map((item) => item.turnId)),
    },
    deps.db,
  );
  // The runs that ran the fix's tools first, then the others the change touches: a holdout it can't affect grades nothing.
  const pool = await loadRuns(
    set.projectId,
    selection.holdout.map((candidate) => candidate.turnId),
    deps.db,
  );
  const own = new Set([
    ...tools,
    ...Object.keys(change.patches),
    ...change.hide,
    ...change.collapse,
    ...change.dedupeRetries,
    ...change.skillSteps,
  ]);
  const relevance = (turnId: string) => {
    const run = pool.get(turnId);
    if (!run || !affects(run, change)) return 0;
    return run.steps.some((step) => step.kind === "invoke" && own.has(step.targetId)) ? 2 : 1;
  };
  const holdout = [...selection.holdout]
    .map((candidate, index) => ({ candidate, index, score: relevance(candidate.turnId) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, room)
    .map((item) => item.candidate);
  const drafted = await draftCases(
    set.projectId,
    [...holdout, ...selection.evidence],
    fix.kind,
    change,
    tools,
    deps.db,
  );
  return addCases(set, drafted, deps.db);
}

/** A run a person adds by its run or trace id, with a drafted expected outcome. */
export async function addRunToSet(
  set: FixEvalSetRow,
  fix: Pick<Fix, "kind" | "subject"> | null,
  raw: string,
  partial?: Partial<EvalGateDeps>,
): Promise<{ ok: true; added: boolean } | { ok: false; reason: "not-found" }> {
  const deps = withDeps(partial);
  const found = await findRun(set.projectId, raw, deps.db);
  if (!found) return { ok: false, reason: "not-found" };
  const change = parseChange(set.change);
  const kind = (fix?.kind ?? set.fixKind) as FixKind;
  const tools = fix?.subject.tools.map((tool) => tool.id) ?? [];
  const drafted = await draftCases(
    set.projectId,
    [{ turnId: found.turnId, origin: "manual", originRef: null }],
    kind,
    change,
    tools,
    deps.db,
  );
  const added = await addCases(
    set,
    drafted.map((item) => ({ ...item, traceId: item.traceId ?? found.traceId })),
    deps.db,
  );
  return { ok: true, added: added > 0 };
}

/* - Simulating --------------------------------------------------------------- */

/** Tool definitions from the catalog, for a skill's steps a run was never offered. */
export async function loadCatalogToolDefs(
  projectId: string,
  names: readonly string[],
  db: EvalDb,
): Promise<Map<string, ToolDef>> {
  if (names.length === 0) return new Map();
  const rows = await db
    .select({
      entryId: runtimeCatalogEntries.entryId,
      description: runtimeCatalogEntries.description,
      inputSchema: runtimeCatalogEntries.inputSchema,
    })
    .from(runtimeCatalogEntries)
    .where(
      and(
        eq(runtimeCatalogEntries.projectId, projectId),
        inArray(runtimeCatalogEntries.entryId, [...names]),
      ),
    );
  return new Map(
    rows.map((row) => [
      row.entryId,
      {
        name: row.entryId,
        description: row.description ?? "",
        parameters: (row.inputSchema as Record<string, unknown> | null) ?? {
          type: "object",
          properties: {},
        },
      },
    ]),
  );
}

/**
 * Run one queued simulation: claim it, simulate every run of the set by the
 * method its fix's kind asks for (RC-61: a re-rank, a model replay, or "can't
 * simulate" with the reason), judge the person's criteria, score both sides
 * and store the result. Called by the job (`simulate_fix_eval`) and inline by
 * `runSimulation`.
 */
export async function executeEvalRun(
  runId: string,
  partial?: Partial<EvalGateDeps>,
): Promise<FixEvalRunRow | null> {
  const deps = withDeps(partial);
  const claimed = await startEvalRun(runId, deps.db);
  if (!claimed) return getEvalRun(runId, deps.db);
  // Every log line of the simulation, its `model_call` lines included, names the project and its organization.
  return withProjectLogContext(claimed.projectId, () => simulateClaimedRun(runId, claimed, deps));
}

async function simulateClaimedRun(
  runId: string,
  claimed: FixEvalRunRow,
  deps: EvalGateDeps,
): Promise<FixEvalRunRow | null> {
  try {
    const set = await getEvalSetById(claimed.setId, deps.db);
    if (!set) throw new Error("eval set not found");
    const change = parseChange(set.change);
    const cases = await listCases(set.id, deps.db);
    const runs = await loadRuns(
      set.projectId,
      cases.map((item) => item.turnId),
      deps.db,
    );
    const evidence = new Set(set.evidenceTurnIds ?? []);
    const method: SimMethod = change.unsupportedReason ? "none" : methodForKind(set.fixKind);
    const ranker =
      method === "rerank" ? createRanker(await deps.loadCorpus(set.projectId), change) : null;
    const models = deps.models ?? resolveEvalModels();
    // The organization's daily budget bounds both meters: what is left of it today, if less than an eval's own cap.
    const now = deps.now?.() ?? new Date();
    const spentToday = await organizationModelSpendSince(
      set.projectId,
      new Date(now.getTime() - DAY_MS),
      deps.db,
    );
    const dailyLeft = Math.max(0, (deps.dailyBudgetUsd ?? DAILY_ORG_BUDGET_USD) - spentToday);
    const replayable =
      method === "replay" && models.agent && dailyLeft > 0 && !replayGap(set.fixKind, change)
        ? cases.filter((item) => runs.has(item.turnId) && affects(runs.get(item.turnId)!, change))
        : [];
    const calls =
      replayable.length > 0
        ? await loadModelCalls(
            set.projectId,
            replayable.map((item) => {
              const run = runs.get(item.turnId)!;
              return {
                turnId: run.turnId,
                startedAt: new Date(run.startedAt),
                endedAt: new Date(run.endedAt ?? run.startedAt),
                traceIds: run.traceIds ?? [],
              };
            }),
            { withPayload: true },
            deps.db,
          )
        : new Map();
    const toolDefs = change.replay?.skill
      ? await loadCatalogToolDefs(set.projectId, change.replay.skill.steps, deps.db)
      : new Map<string, ToolDef>();

    const simulation = await simulateCases(
      cases.map((item) => ({
        ...item,
        run: runs.get(item.turnId) ?? null,
        calls: calls.get(item.turnId) ?? [],
        role: roleOf(item, evidence),
      })),
      { ...change, kind: set.fixKind, ranker, toolDefs },
      models,
      {
        dailyLeftUsd: dailyLeft,
        replayUsd: deps.replayBudgetUsd,
        judgeUsd: deps.judgeBudgetUsd,
        maxSteps: deps.maxSteps,
      },
    );
    const { results, spend, judge } = simulation;
    const summary: SimulationSummary = summarize(
      results,
      `${set.id}:${runId}`,
      change.unsupportedReason !== null,
    );
    const completed = await completeEvalRun(
      runId,
      { summary, results, change, spend, judge: judge.status },
      deps.db,
    );
    logSimulationFinished(claimed, completed, method);
    return completed;
  } catch (err) {
    logger.error(
      { err, run_id: runId, project_id: claimed.projectId },
      "fix eval simulation failed",
    );
    await failEvalRun(runId, err instanceof Error ? err.message : String(err), deps.db);
    const failed = await getEvalRun(runId, deps.db);
    logSimulationFinished(claimed, failed, null);
    return failed;
  }
}

/**
 * One `fix_eval_simulation_finished` line per simulation that ran, completed
 * or failed, for the improvement loop dashboard and its failure monitor. A
 * failed simulation never reaches `job_failed`: the run is marked failed here
 * and the job completes. The organization comes from the log context.
 */
function logSimulationFinished(
  claimed: FixEvalRunRow,
  run: FixEvalRunRow | null,
  method: SimMethod | null,
): void {
  try {
    logger.info(
      simulationFinishedFields(claimed, run, method, currentLogContext().org_id ?? null),
      "fix_eval_simulation_finished",
    );
  } catch {
    // Called inside the simulation's try: a logging failure must not mark a completed run failed.
  }
}

/** The fields of `fix_eval_simulation_finished`: the stored run's outcome, never its content. */
export function simulationFinishedFields(
  claimed: FixEvalRunRow,
  run: FixEvalRunRow | null,
  method: SimMethod | null,
  organizationId: string | null,
  now: number = Date.now(),
): Record<string, unknown> {
  const row = run ?? claimed;
  const methods = parseMethods(row.methods);
  const spend = parseSpend(row.spend);
  const started = (claimed.startedAt ?? claimed.createdAt).getTime();
  return {
    run_id: row.id,
    set_id: row.setId,
    project_id: row.projectId,
    organization_id: organizationId,
    trigger: row.trigger,
    status: run ? parseStatus(run.status) : "failed",
    verdict: parseVerdict(row.verdict),
    method,
    n_cases: row.nCases,
    n_simulated: row.nSimulated,
    methods_replay: methods?.replay ?? 0,
    methods_rerank: methods?.rerank ?? 0,
    methods_none: methods?.none ?? 0,
    spend_usd: spend?.usd ?? 0,
    spend_calls: spend?.calls ?? 0,
    duration_ms: Math.max(0, now - started),
  };
}

export interface RunSimulationOptions {
  /** The project, when the caller knows it (skips resolving it from the fix's own row). */
  projectId?: string;
  trigger?: "manual" | "mcp";
  /** Queue the job and return at once (the eval page); by default it runs inline and returns the result. */
  background?: boolean;
  /** Who asked: a Clerk id, `project:<id>` for an API key, or `system:<name>`. */
  actor?: string;
  deps?: Partial<EvalGateDeps>;
}

export class EvalGateError extends Error {
  constructor(
    /** `nothing-to-simulate` (RC-77): the message is why, and nothing was queued. */
    readonly code: "fix-not-found" | "project-not-found" | "nothing-to-simulate",
    message: string,
  ) {
    super(message);
    this.name = "EvalGateError";
  }
}

/**
 * Simulate a fix on its eval set (made on first use) and return the result:
 * pass rate and score before and after, on N of the project's historical
 * runs. Never touches the customer's live environment. A fix with nothing to
 * simulate throws `EvalGateError("nothing-to-simulate")` with the reason (RC-77).
 */
export async function runSimulation(
  fixId: string,
  options: RunSimulationOptions = {},
): Promise<SimulationOutcome> {
  const deps = withDeps(options.deps);
  const projectId = options.projectId ?? (await resolveFixProject(fixId, deps.db));
  if (!projectId) throw new EvalGateError("project-not-found", "No project has this fix.");
  const ctx = await deps.loadFix(projectId, fixId);
  if (!ctx)
    throw new EvalGateError("fix-not-found", "This fix isn't open in the project any more.");
  const actor =
    options.actor ?? (options.trigger === "mcp" ? `project:${projectId}` : "system:eval-gate");
  // RC-77: a fix with nothing to simulate is refused before a set or a run exists: no slot, no model call.
  const { change } = await resolveFixChange(projectId, ctx.fix, {
    db: deps.db,
    actor,
  });
  const gap = nothingToSimulate(ctx.fix.kind, change);
  if (gap) {
    logger.info(
      {
        project_id: projectId,
        fix_id: ctx.fix.id,
        fix_kind: ctx.fix.kind,
        trigger: options.trigger ?? "manual",
        reason: "nothing_to_simulate",
      },
      "fix eval simulation refused",
    );
    throw new EvalGateError("nothing-to-simulate", gap);
  }
  const { set } = await ensureEvalSet(ctx, actor, deps);
  await recordEvalLineage(projectId, ctx.fix, set, actor, deps);
  const { run, created } = await queueEvalRun(
    set,
    { trigger: options.trigger ?? "manual", requestedBy: actor, replay: true },
    deps.db,
  );
  let current: FixEvalRunRow | null = run;
  if (options.background) {
    if (created) {
      let jobId: string | null;
      try {
        jobId = await deps.enqueue(projectId, run.id);
      } catch (err) {
        // No job will ever claim this run: fail it so it doesn't hold the set's one live slot.
        await failEvalRun(run.id, "Couldn't queue the simulation.", deps.db);
        throw err;
      }
      if (jobId) await setRunJob(run.id, jobId, deps.db);
    }
  } else if (run.status === "queued") {
    current = await executeEvalRun(run.id, deps);
  }
  return outcomeOf(projectId, ctx.fix, set, current ?? run);
}

export function outcomeOf(
  projectId: string,
  fix: Pick<Fix, "id" | "short">,
  set: FixEvalSetRow,
  run: FixEvalRunRow,
): SimulationOutcome {
  const nSimulated = run.nSimulated;
  return {
    fixId: fix.id,
    projectId,
    setId: set.id,
    runId: run.id,
    status: parseStatus(run.status),
    label: simulatedLabel(nSimulated),
    nCases: run.nCases,
    nSimulated,
    before: parseTally(run.before),
    after: parseTally(run.after),
    verdict: parseVerdict(run.verdict),
    href: evalHref(projectId, set.fixId),
    source: parseLineageRef(set.source),
    fix: fixRef(projectId, fix),
    eval: evalRef(projectId, set),
    error: run.error,
    evidence: parseEvidence(run.evidence),
    methods: parseMethods(run.methods),
    spend: parseSpend(run.spend),
  };
}

/* - Reading ------------------------------------------------------------------ */

/**
 * The fix's newest simulation as `runSimulation` reports it, or null when it
 * was never simulated (RC-70: what MCP polls after `run_eval` queues one). A
 * live run past its timeout reads as failed, as the badge does.
 */
export async function latestEvalOutcome(
  projectId: string,
  fix: Pick<Fix, "id" | "short">,
  db: EvalDb = getDb(),
  now: number = Date.now(),
): Promise<SimulationOutcome | null> {
  const set = await getEvalSet(projectId, fix.id, db);
  if (!set) return null;
  const [run] = await listEvalRuns(set.id, 1, db);
  if (!run) return null;
  const outcome = outcomeOf(projectId, fix, set, run);
  return isTimedOut(run, now)
    ? { ...outcome, status: "failed", error: outcome.error ?? "The simulation timed out." }
    : outcome;
}

export function badgeOf(
  set: Pick<FixEvalSetRow, "updatedAt">,
  run: FixEvalRunRow | null,
  now: number = Date.now(),
): EvalBadge {
  if (!run) return { state: "none" };
  // A live run past its timeout will never finish (the next request fails it for good): read it as failed so the poller stops.
  if (isTimedOut(run, now)) return { state: "failed", runs: run.nCases };
  const status = parseStatus(run.status);
  if (status === "queued" || status === "running") return { state: "pending", runs: run.nCases };
  if (status === "failed") return { state: "failed", runs: run.nCases };
  const before = parseTally(run.before) ?? { passed: 0, total: 0, passRate: null, score: null };
  const after = parseTally(run.after) ?? { passed: 0, total: 0, passRate: null, score: null };
  const finished = run.finishedAt ?? run.createdAt;
  return {
    state: "done",
    verdict: parseVerdict(run.verdict) ?? "too-few",
    before,
    after,
    runs: run.nSimulated,
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    stale: set.updatedAt.getTime() > finished.getTime(),
    ...(methodOfRun(run) ? { method: methodOfRun(run)! } : {}),
  };
}

/** How a simulation's graded runs were simulated, in one word; null on simulations before RC-61. */
export function methodOfRun(run: Pick<FixEvalRunRow, "methods">): SimMethod | "mixed" | null {
  const methods = parseMethods(run.methods);
  if (!methods) return null;
  if (methods.replay > 0 && methods.rerank > 0) return "mixed";
  if (methods.replay > 0) return "replay";
  if (methods.rerank > 0) return "rerank";
  return "none";
}

/** Each fix's badge, by fix id; a fix without a set is absent (read as "not simulated"). */
export async function listEvalBadges(
  projectId: string,
  db: EvalDb = getDb(),
): Promise<Record<string, EvalBadge>> {
  const rows = await listSetsWithLatestRun(projectId, db);
  return Object.fromEntries(rows.map(({ set, run }) => [set.fixId, badgeOf(set, run)]));
}

/** The trace ids of runs added before their trace was known, for links. */
export async function backfillTraceIds(
  projectId: string,
  turnIds: readonly string[],
  db: EvalDb = getDb(),
): Promise<Map<string, string>> {
  return traceIdsOf(projectId, turnIds, db);
}

export { getEvalRun, getEvalSet };
