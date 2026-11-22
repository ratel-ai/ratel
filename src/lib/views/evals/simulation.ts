import { and, eq, inArray } from "drizzle-orm";
import { loadJobPriceBook } from "@/lib/ingest/model-pricing/price-book";
import { createBackgroundObservability } from "@/lib/jobs/observability";
import { jobs } from "@/lib/jobs/schema";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import {
  defaultOrganizationFlagDeps,
  type OrganizationFlagDeps,
} from "@/lib/platform/organization-flags";
import { CANT_SIMULATE } from "@/lib/views/eval-gate/method";
import { DAILY_ORG_BUDGET_USD, SpendMeter } from "@/lib/views/eval-gate/models";
import { recordedScenario, replayAsRecorded, replayInput } from "@/lib/views/eval-gate/replay";
import { resolveFixChange } from "@/lib/views/eval-gate/seams";
import {
  type FixContext,
  loadCatalogToolDefs,
  loadFixContext,
} from "@/lib/views/eval-gate/service";
import type { FixChange, ToolDef } from "@/lib/views/eval-gate/types";
import { evalRuns } from "@/lib/views/evals/schema";
import { DRAFTING_MESSAGE } from "@/lib/views/fix-drafts/resolve";
import { createDrizzleEvalStore } from "./adapters/drizzle-store";
// Owned: counts eval set runs in the daily budget (organizationModelSpendSince).
import "./spend";
import { effectiveScorers } from "./domain/scoring";
import {
  parseSimulationSuite,
  type SimulationRow,
  type SimulationSuite,
  selectSuite,
  simulationRowsOf,
  tallySimulation,
} from "./domain/simulation";
import { EVAL_RUNS_KEEP_TEXT, type EvalRun, IN_SET_STATUSES } from "./domain/types";
import { EVALS_OFF_ERROR, evalsEnabledForActor } from "./gate";
import { loadEvalReplays, type RunEvalSetDeps, reserveEvalRun, scoredResult } from "./job";
import type { EvalStore, NewEvalResult } from "./ports/store";
import { evalReplayExtras } from "./replay-extras";
import type { ActionResult } from "./run";
import { type EvalRunSettings, evalMeter, loadEvalRunSettings } from "./run-settings";
import { generatedInputsOf, specOnlyReplay, specScenarioOf } from "./spec-scenario";
import { enabledTaskScorers } from "./task-scorers";

/**
 * RC-293: a fix runs evals as simulations. "Run evals" on a fix queues one
 * `simulation` run of a suite of the eval set (the fix's own tasks by
 * default) and its `simulate_eval_set` job; each new suite is a new line. The
 * job replays every eval twice with the same model and the same rules: as
 * recorded (`before`, the agent today) and with the fix applied (`after`). An
 * eval whose model input the fix does not change gets one replay, the same as
 * today. Fixes are computed ids (craft:/rewrite:/issue:/intent:), not rows:
 * the change is resolved when the run is queued and travels in the job.
 * RC-653: both sides of an eval run with its run settings, under the suite's
 * budget for the whole run, and both results record them.
 */

export const SIMULATE_EVAL_SET_JOB = "simulate_eval_set" as const;

export interface SimulateEvalSetPayload {
  runId: string;
  evalIds: string[];
  change: FixChange;
}

export interface QueueEvalSimulationDeps {
  db?: ReturnType<typeof getDb>;
  flagDeps?: OrganizationFlagDeps;
  /** The fix as Fixes shows it; null when the project has no such fix. */
  loadFix?: (projectId: string, fixId: string) => Promise<FixContext | null>;
}

export interface RequestEvalSimulationDeps extends QueueEvalSimulationDeps {
  getSession: () => Promise<{ user: { id: string; externalId: string } } | null>;
  findProjectScope: (
    projectId: string,
    userId: string,
  ) => Promise<{ project: { id: string }; organization: { id: string } } | null>;
  track?: (event: {
    externalId: string;
    projectId: string;
    organizationId: string;
    runId: string;
    fixId: string;
    suite: SimulationSuite["kind"];
    evalCount: number;
  }) => Promise<void>;
}

export type RunEvalSimulationDeps = RunEvalSetDeps;

/** One line of a fix page: the run, the tasks its evals belong to, and its counts. */
export interface SimulationLine {
  run: EvalRun;
  tasks: string[];
  tally: ReturnType<typeof tallySimulation>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FIX_ID = 500;
const NO_FIX = "This fix does not exist in the project.";
const logger = getLogger("evals/simulation");
const EVAL_ACTOR = "system:evals";

/** The server action's work: the caller must be a member and have `cloud-eval-gate` on. */
export async function requestEvalSimulation(
  projectId: string,
  fixId: string,
  suiteInput: unknown,
  deps: RequestEvalSimulationDeps,
): Promise<ActionResult<EvalRun>> {
  const session = await deps.getSession();
  if (!session) return { ok: false, error: "Sign in to run evals." };
  const scope = UUID.test(projectId)
    ? await deps.findProjectScope(projectId, session.user.id)
    : null;
  if (!scope) return { ok: false, error: "No project you belong to has that ID." };
  const actor = session.user.externalId;
  const db = deps.db ?? getDb();
  if (
    !(await evalsEnabledForActor(
      scope.project.id,
      actor,
      db,
      deps.flagDeps ?? defaultOrganizationFlagDeps,
    ))
  ) {
    return { ok: false, error: EVALS_OFF_ERROR };
  }
  const suite = parseSimulationSuite(suiteInput);
  if (!suite) return { ok: false, error: "That is not a suite of evals." };
  const queued = await queueEvalSimulation(scope.project.id, actor, fixId, suite, { ...deps, db });
  if (!queued.ok) return queued;
  const { run, created } = queued.value;
  if (created) {
    logger.info(
      {
        project_id: run.projectId,
        run_id: run.id,
        fix_id: fixId,
        suite: suite.kind,
        eval_count: run.evalCount,
        actor,
      },
      "eval_simulation_queued",
    );
    await deps.track?.({
      externalId: actor,
      projectId: run.projectId,
      organizationId: scope.organization.id,
      runId: run.id,
      fixId,
      suite: suite.kind,
      evalCount: run.evalCount,
    });
  }
  return { ok: true, value: run };
}

/**
 * Resolve the fix's change, choose the suite's evals, and insert the
 * run with its job in one transaction. A second click on the same fix and
 * suite while its line is live gets that line back (an added list is always new).
 */
export async function queueEvalSimulation(
  projectId: string,
  actor: string,
  fixId: string,
  suite: SimulationSuite,
  deps: QueueEvalSimulationDeps = {},
): Promise<ActionResult<{ run: EvalRun; created: boolean }>> {
  const db = deps.db ?? getDb();
  if (!fixId || fixId.length > MAX_FIX_ID) return { ok: false, error: NO_FIX };
  const ctx = await (deps.loadFix ?? loadFixContext)(projectId, fixId);
  if (!ctx || ctx.projectId !== projectId) return { ok: false, error: NO_FIX };
  const resolved = await resolveFixChange(projectId, ctx.fix, {
    db,
    actor,
    // Owned: the drafted change rides FF_EVAL_GATE, which the seam reads from the environment.
    ...(deps.flagDeps?.flags?.env ? { env: { ...deps.flagDeps.flags.env } } : {}),
  });
  if (resolved.status === "drafting") return { ok: false, error: DRAFTING_MESSAGE };
  if (resolved.status !== "ready")
    return {
      ok: false,
      error: resolved.change.unsupportedReason ?? "This fix cannot be simulated.",
    };
  const store = createDrizzleEvalStore(db);
  const evals = await store.listEvals(projectId, { statuses: IN_SET_STATUSES });
  const { evalIds, label } = selectSuite(suite, {
    evals,
    fixTasks: ctx.fix.subject.tasks.map((task) => task.id),
    failingToday: suite.kind === "failing" ? await failingToday(projectId, store) : new Set(),
  });
  if (evalIds.length === 0) return { ok: false, error: "No evals are in this suite." };
  return db.transaction(async (tx) => {
    const txStore = createDrizzleEvalStore(tx as unknown as ReturnType<typeof getDb>);
    if (suite.kind !== "list") {
      const [live] = await tx
        .select({ id: evalRuns.id })
        .from(evalRuns)
        .where(
          and(
            eq(evalRuns.projectId, projectId),
            eq(evalRuns.kind, "simulation"),
            eq(evalRuns.fixId, ctx.fix.id),
            eq(evalRuns.suite, label),
            inArray(evalRuns.status, ["queued", "running"]),
          ),
        )
        .limit(1)
        .for("update");
      if (live)
        return {
          ok: true as const,
          value: { run: (await txStore.getRun(projectId, live.id))!, created: false },
        };
    }
    const run = await txStore.createRun({
      projectId,
      kind: "simulation",
      fixId: ctx.fix.id,
      createdBy: actor,
      suite: label,
      evalCount: evalIds.length,
    });
    const payload: SimulateEvalSetPayload = { runId: run.id, evalIds, change: resolved.change };
    await tx
      .insert(jobs)
      .values({ projectId, kind: SIMULATE_EVAL_SET_JOB, payload: { ...payload } });
    return { ok: true as const, value: { run, created: true } };
  });
}

/**
 * The `simulate_eval_set` job. Spend is reserved first under the organization
 * lock, as for an eval run, and both sides of every eval share the meter.
 */
export async function runEvalSimulationJob(
  projectId: string,
  payload: unknown,
  deps: RunEvalSimulationDeps = {},
) {
  const parsed = parseSimulateEvalSetPayload(payload);
  if (!parsed) return { ran: false, reason: "invalid_payload" };
  const db = deps.db ?? getDb();
  const store = createDrizzleEvalStore(db);
  const queued = await store.getRun(projectId, parsed.runId);
  if (!queued || queued.kind !== "simulation") return { ran: false, reason: "run_not_found" };
  if (queued.status !== "queued")
    return { ran: queued.status === "completed", status: queued.status };
  const now = () => deps.now?.() ?? new Date();
  if (!(await evalsEnabledForActor(projectId, queued.createdBy, db, deps.flagDeps))) {
    await store.updateRun(projectId, queued.id, {
      status: "failed",
      error: EVALS_OFF_ERROR,
      finishedAt: now(),
    });
    return { ran: false, reason: "flag_off" };
  }
  const settings: EvalRunSettings = await loadEvalRunSettings(store, projectId, deps);
  const reserved = await reserveEvalRun(
    queued,
    settings.suite.budgetUsd,
    deps.dailyBudgetUsd ?? DAILY_ORG_BUDGET_USD,
    db,
    now(),
  );
  if (reserved === null) return { ran: false, reason: "already_claimed" };
  const meter = new SpendMeter(reserved);
  try {
    const wanted = new Set(parsed.evalIds);
    const evals = (await store.listEvals(projectId)).filter((item) => wanted.has(item.id));
    const scorers = await enabledTaskScorers(
      projectId,
      evals.flatMap((item) => item.tasks),
      db,
    );
    const replays = await (deps.loadReplays ?? ((id, turnIds) => loadEvalReplays(id, turnIds, db)))(
      projectId,
      evals.flatMap((item) => item.sourceTurnId ?? []),
    );
    // RC-641 (decision eval-text-kept): this job runs only with the eval gate on, and then an eval run keeps its text
    // whatever the content opt-in is. `pruneTranscripts` clears it after EVAL_TRANSCRIPT_TTL_DAYS.
    const keepText = EVAL_RUNS_KEEP_TEXT;
    const { change } = parsed;
    const toolDefs = change.replay?.skill
      ? await loadCatalogToolDefs(projectId, change.replay.skill.steps, db)
      : new Map<string, ToolDef>();
    const prices = await loadJobPriceBook(projectId, db);
    const halt = { reason: null as string | null };
    const results: NewEvalResult[] = [];
    // One at a time: the meter is shared, and a refused key stops the rest without calling.
    for (const item of evals) {
      // RC-609: an eval with a spec fills what its recording lacks, and runs from the spec alone when it has none.
      const scenario = specScenarioOf(item);
      const replay =
        (item.sourceTurnId ? replays.get(item.sourceTurnId) : undefined) ??
        (scenario ? specOnlyReplay(item.id, item.createdAt) : undefined);
      if (!replay) {
        results.push({
          evalId: item.id,
          side: "before",
          passed: null,
          verdicts: [],
          error: "The recorded run is gone.",
        });
        continue;
      }
      const runSettings = settings.forEval(item);
      const blocked = settings.blocked(runSettings);
      if (blocked) {
        results.push({
          evalId: item.id,
          side: "before",
          passed: null,
          verdicts: [],
          error: blocked,
          runSettings,
        });
        continue;
      }
      const spend = evalMeter(meter, runSettings);
      const replayDeps = {
        models: settings.modelsFor(runSettings),
        spend,
        maxSteps: runSettings.maxSteps,
        toolDefs,
        halt,
        budgetNote: CANT_SIMULATE.budget,
        trace: { keepText },
        ...(prices ? { prices } : {}),
      };
      const held = effectiveScorers(
        item.tasks.map((task) => scorers.get(task) ?? []),
        item,
      );
      const recording = (scenario ?? recordedScenario)({ run: replay.run, calls: replay.calls });
      const touched = recording !== null && replayInput(recording, change, toolDefs).touched;
      const extras = evalReplayExtras(item);
      const sideDeps = scenario ? { ...replayDeps, scenario } : replayDeps;
      const generated = scenario ? generatedInputsOf(item, replay) : [];
      const used = { ...(generated.length > 0 ? { generated } : {}), runSettings };
      try {
        let started = Date.now();
        const before = await replayAsRecorded(replay.run, replay.calls, sideDeps, extras);
        results.push({
          ...scoredResult(item.id, before, held, keepText, Date.now() - started),
          side: "before",
          ...used,
        });
        if (!touched || !before.ok) continue;
        started = Date.now();
        const after = await replayAsRecorded(replay.run, replay.calls, sideDeps, extras, change);
        results.push({
          ...scoredResult(item.id, after, held, keepText, Date.now() - started),
          side: "after",
          ...used,
        });
      } finally {
        meter.absorb(spend);
      }
    }
    await store.recordResults(projectId, queued.id, results);
    await store.updateRun(projectId, queued.id, {
      status: "completed",
      finishedAt: now(),
      spend: { usd: meter.usd, reservedUsd: reserved, reserved: false },
    });
    logger.info(
      {
        project_id: projectId,
        run_id: queued.id,
        fix_id: queued.fixId,
        n_evals: evals.length,
        n_after: results.filter((r) => r.side === "after").length,
        spend_usd: meter.usd,
        reserved_usd: reserved,
      },
      "eval_simulation_finished",
    );
    await (deps.observability ?? createBackgroundObservability()).trackSystemEvent(
      "eval_simulation_finished",
      EVAL_ACTOR,
      {
        object_action: "eval_simulation_finished",
        project_id: projectId,
        run_id: queued.id,
        fix_id: queued.fixId,
        status: "completed",
        eval_count: evals.length,
      },
    );
    return { ran: true, status: "completed", runId: queued.id };
  } catch (err) {
    logger.error({ err, project_id: projectId, run_id: queued.id }, "eval simulation failed");
    await store.updateRun(projectId, queued.id, {
      status: "failed",
      finishedAt: now(),
      error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      spend: { usd: meter.usd, reservedUsd: reserved, reserved: false },
    });
    throw err;
  }
}

/** A fix's simulation lines, newest first. A queued line has no results yet. */
export async function fixSimulations(
  projectId: string,
  fixId: string,
  db: ReturnType<typeof getDb> = getDb(),
): Promise<SimulationLine[]> {
  const store = createDrizzleEvalStore(db);
  const runs = await store.listRuns(projectId, { kinds: ["simulation"], fixId });
  if (runs.length === 0) return [];
  const tasksOf = new Map((await store.listEvals(projectId)).map((item) => [item.id, item.tasks]));
  return Promise.all(
    runs.map(async (run) => {
      const rows = simulationRowsOf(await store.listResults(projectId, run.id));
      const tasks = [...new Set(rows.flatMap((row) => tasksOf.get(row.evalId) ?? []))].sort();
      return { run, tasks, tally: tallySimulation(rows) };
    }),
  );
}

/** One simulation's run and its evals, each with both sides and its outcome. Null when the run is not a simulation of the project. */
export async function simulationRows(
  projectId: string,
  runId: string,
  db: ReturnType<typeof getDb> = getDb(),
): Promise<{ run: EvalRun; rows: SimulationRow[] } | null> {
  if (!UUID.test(runId)) return null;
  const store = createDrizzleEvalStore(db);
  const run = await store.getRun(projectId, runId);
  if (!run || run.kind !== "simulation") return null;
  return { run, rows: simulationRowsOf(await store.listResults(projectId, run.id)) };
}

export function parseSimulateEvalSetPayload(payload: unknown): SimulateEvalSetPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const { runId, evalIds, change } = payload as Record<string, unknown>;
  if (typeof runId !== "string" || !UUID.test(runId)) return null;
  if (!Array.isArray(evalIds) || !evalIds.every((id) => typeof id === "string")) return null;
  if (!change || typeof change !== "object" || (change as { version?: unknown }).version !== 1)
    return null;
  return { runId, evalIds, change: change as FixChange };
}

/** The evals that failed in the latest completed manual or nightly run: the agent today. */
export async function failingToday(projectId: string, store: EvalStore): Promise<Set<string>> {
  const latest = (
    await store.listRuns(projectId, { kinds: ["manual", "nightly"], limit: 20 })
  ).find((run) => run.status === "completed");
  if (!latest) return new Set();
  return new Set(
    (await store.listResults(projectId, latest.id))
      .filter((result) => result.side === "before" && result.passed === false)
      .map((result) => result.evalId),
  );
}
