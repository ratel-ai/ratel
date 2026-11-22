import { and, eq } from "drizzle-orm";
import { loadJobPriceBook } from "@/lib/ingest/model-pricing/price-book";
import {
  type BackgroundObservability,
  createBackgroundObservability,
} from "@/lib/jobs/observability";
import { getDb } from "@/lib/platform/db/client";
import { hasPaidPlan } from "@/lib/platform/entitlements";
import { getLogger } from "@/lib/platform/logger";
import type { OrganizationFlagDeps } from "@/lib/platform/organization-flags";
import { getOrganizationById } from "@/lib/platform/organizations";
import { projects } from "@/lib/platform/projects/schema";
import { loadModelCalls, type ModelCall } from "@/lib/views/eval-gate/calls";
import { CANT_SIMULATE } from "@/lib/views/eval-gate/method";
import { DAILY_ORG_BUDGET_USD, SpendMeter } from "@/lib/views/eval-gate/models";
import type { RecordedReplayOutcome } from "@/lib/views/eval-gate/replay";
import { loadRuns } from "@/lib/views/eval-gate/runs";
import { lockOrganizationSpend, organizationModelSpendSince } from "@/lib/views/eval-gate/store";
import type { RunRecord, ToolDef } from "@/lib/views/eval-gate/types";
import { evalRuns } from "@/lib/views/evals/schema";
import {
  type DecisionEngineFactory,
  decisionEngineFromEnv,
  decisionPortOf,
  meteredJudgePort,
} from "@/lib/views/scorers/adapters/models";
import { type RunScoreInput, saveRunScores } from "@/lib/views/scorers/adapters/run-scores";
import { drizzleScorerRepository } from "@/lib/views/scorers/adapters/store";
import { applicableScorers } from "@/lib/views/scorers/domain/engine";
import type { ScoreResult, Scorer as UserScorer } from "@/lib/views/scorers/domain/types";
import type { Scorer } from "@/lib/views/task-scorers/types";
import { createDrizzleEvalStore } from "./adapters/drizzle-store";
// Owned: counts eval set runs in the daily budget (organizationModelSpendSince).
import "./spend";
import { changeFrom, effectiveScorers, verdictsOf } from "./domain/scoring";
import { EVAL_RUNS_KEEP_TEXT, type EvalRun, IN_SET_STATUSES } from "./domain/types";
import { EVALS_OFF_ERROR, evalsEnabledForActor } from "./gate";
import {
  NIGHTLY_CAP_ERROR,
  NIGHTLY_EVAL_BUDGET_USD,
  NIGHTLY_PAID_ERROR,
  nightlyBudgetLeft,
} from "./nightly";
import type { NewEvalResult } from "./ports/store";
import { parseRunEvalSetPayload } from "./run";
import { evalMeter, loadEvalRunSettings, type RunSettingsDeps, runCapUsd } from "./run-settings";
import { generatedInputsOf, specOnlyReplay, specScenarioOf } from "./spec-scenario";
import { enabledTaskScorers } from "./task-scorers";
import { runEvalTurns } from "./turns";

/**
 * RC-289: the `run_eval_set` job. Each eval's recorded run is
 * replayed against the agent as recorded (no fix), scored by its tasks'
 * scorers with the eval's own checks on top, and compared with the previous
 * completed run. RC-295: the eval's earlier messages go first as history,
 * and its fixed answers win over the recording. RC-296: an eval with turns
 * replays them in order (`turns.ts`). Model spend is reserved first under the organization lock
 * and never passes the reservation. RC-641: replay text is kept for
 * EVAL_TRANSCRIPT_TTL_DAYS, whatever the content opt-in. A nightly run (RC-299) runs only while the
 * organization is on a paid plan and holds no more than what is left of the
 * project's nightly cap today; with nothing left it stops and says why.
 * RC-653: each eval runs with its run settings (its own, else the suite's,
 * else today's): its models, step limit and budget. Each result records them.
 */

export interface EvalReplay {
  run: RunRecord;
  calls: readonly ModelCall[];
}

export interface RunEvalSetDeps extends RunSettingsDeps {
  db?: ReturnType<typeof getDb>;
  flagDeps?: OrganizationFlagDeps;
  /** The most one run may spend on models: today's default budget, under an eval's or the suite's. */
  runBudgetUsd?: number;
  dailyBudgetUsd?: number;
  /** A project's nightly cap for a UTC day. */
  nightlyBudgetUsd?: number;
  /** The recorded runs to replay, by turn id. Defaults to the trace ledger and its model calls. */
  loadReplays?: (projectId: string, turnIds: readonly string[]) => Promise<Map<string, EvalReplay>>;
  now?: () => Date;
  observability?: Pick<BackgroundObservability, "trackSystemEvent">;
  /** RC-613: the decision engine for decision scorers. Defaults to `DECISION_ENGINE`. */
  decision?: DecisionEngineFactory | null;
}

const logger = getLogger("evals/job");
const EVAL_ACTOR = "system:evals";

export async function runEvalSetJob(
  projectId: string,
  payload: unknown,
  deps: RunEvalSetDeps = {},
) {
  const parsed = parseRunEvalSetPayload(payload);
  if (!parsed) return { ran: false, reason: "invalid_payload" };
  const db = deps.db ?? getDb();
  const store = createDrizzleEvalStore(db);
  const queued = await store.getRun(projectId, parsed.runId);
  if (!queued) return { ran: false, reason: "run_not_found" };
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
  const nightly = queued.kind === "nightly";
  if (nightly && !(await organizationPaid(projectId, db))) {
    await store.updateRun(projectId, queued.id, {
      status: "failed",
      error: NIGHTLY_PAID_ERROR,
      finishedAt: now(),
    });
    return { ran: false, reason: "not_paid" };
  }
  const evals = parsed.evalId
    ? (await store.listEvals(projectId, { statuses: IN_SET_STATUSES })).filter(
        (item) => item.id === parsed.evalId,
      )
    : await store.listEvals(projectId, {
        statuses: IN_SET_STATUSES,
        ...(parsed.workflowId ? { workflowId: parsed.workflowId } : {}),
      });
  const settings = await loadEvalRunSettings(store, projectId, deps);
  const runBudget = runCapUsd(settings, evals, parsed.evalId !== undefined);
  const capUsd = nightly
    ? Math.min(
        runBudget,
        await nightlyBudgetLeft(
          projectId,
          queued.id,
          now(),
          db,
          deps.nightlyBudgetUsd ?? NIGHTLY_EVAL_BUDGET_USD,
        ),
      )
    : runBudget;
  const reserved = await reserveEvalRun(
    queued,
    capUsd,
    deps.dailyBudgetUsd ?? DAILY_ORG_BUDGET_USD,
    db,
    now(),
  );
  if (reserved === null) return { ran: false, reason: "already_claimed" };
  if (nightly && reserved <= 0) {
    await store.updateRun(projectId, queued.id, {
      status: "failed",
      error: NIGHTLY_CAP_ERROR,
      finishedAt: now(),
      spend: { usd: 0, reservedUsd: 0, reserved: false },
    });
    logger.info({ project_id: projectId, run_id: queued.id }, "eval_nightly_capped");
    return { ran: false, reason: "cap" };
  }
  const meter = new SpendMeter(reserved);
  try {
    const scorers = await enabledTaskScorers(
      projectId,
      evals.flatMap((item) => item.tasks),
      db,
    );
    const user = await userScorersFor(
      projectId,
      evals.map((item) => item.id),
      db,
    );
    const decision = user.anyDecision
      ? decisionPortOf(
          deps.decision === undefined ? decisionEngineFromEnv() : (deps.decision ?? (() => null)),
        )
      : null;
    const readings = new Map<string, ScoreResult[]>();
    const replays = await (deps.loadReplays ?? ((id, turnIds) => loadEvalReplays(id, turnIds, db)))(
      projectId,
      evals.flatMap((item) => item.sourceTurnId ?? []),
    );
    // RC-641 (decision eval-text-kept): this job runs only with the eval gate on, and then an eval run keeps its text
    // whatever the content opt-in is. `pruneTranscripts` clears it after EVAL_TRANSCRIPT_TTL_DAYS.
    const keepText = EVAL_RUNS_KEEP_TEXT;
    const prices = await loadJobPriceBook(projectId, db);
    const previous = await store.recentResults(
      projectId,
      evals.map((item) => item.id),
      1,
    );
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
          passed: null,
          verdicts: [],
          error: "The recorded run is gone.",
        });
        continue;
      }
      const generated = scenario ? generatedInputsOf(item, replay) : [];
      const runSettings = settings.forEval(item);
      const blocked = settings.blocked(runSettings);
      if (blocked) {
        results.push({ evalId: item.id, passed: null, verdicts: [], error: blocked, runSettings });
        continue;
      }
      const models = settings.modelsFor(runSettings);
      const spend = evalMeter(meter, runSettings);
      const ports = {
        judge: models.judge ? meteredJudgePort(models.judge, spend) : null,
        decision,
      };
      const started = Date.now();
      const outcome = await runEvalTurns(item, replay, {
        replay: {
          models,
          spend,
          maxSteps: runSettings.maxSteps,
          toolDefs: new Map<string, ToolDef>(),
          halt,
          budgetNote: CANT_SIMULATE.budget,
          trace: { keepText },
          ...(prices ? { prices } : {}),
          ...(scenario ? { scenario } : {}),
        },
        person: models.person ?? null,
        scorers: effectiveScorers(
          item.tasks.map((task) => scorers.get(task) ?? []),
          item,
        ),
        criteriaJudge: ports.judge,
        user: { scorers: user.forEval(item.id, item.tasks), ports },
      }).finally(() => meter.absorb(spend));
      if (outcome.scores) readings.set(item.id, outcome.scores);
      const { toolAnswers, transcript, turns, attempts } = outcome;
      if (outcome.error) {
        results.push({
          evalId: item.id,
          passed: null,
          verdicts: [],
          toolAnswers,
          transcript,
          turns,
          attempts,
          error: outcome.error,
          durationMs: Date.now() - started,
          ...(generated.length > 0 ? { generated } : {}),
          runSettings,
        });
        continue;
      }
      results.push({
        evalId: item.id,
        passed: outcome.passed,
        verdicts: outcome.verdicts,
        change: changeFrom(previous.get(item.id)?.[0]?.passed, outcome.passed),
        durationMs: outcome.durationMs,
        costUsd: outcome.costUsd,
        toolCalls: outcome.toolCalls,
        toolAnswers,
        transcript,
        turns,
        attempts,
        ...(generated.length > 0 ? { generated } : {}),
        runSettings,
      });
    }
    await store.recordResults(projectId, queued.id, results);
    await saveRunScores(
      projectId,
      [...readings].flatMap(([evalId, scores]) =>
        scores.map(
          (result): RunScoreInput => ({
            scorer: user.byId.get(result.scorerId)!,
            result,
            day: now().toISOString().slice(0, 10),
            evalRunId: queued.id,
            evalId,
          }),
        ),
      ),
      db,
    );
    // A nightly run whose replays ran out of budget completed, but stopped at the cap: the Runs tab says so.
    const capped = nightly && results.some((r) => r.error === CANT_SIMULATE.budget);
    await store.updateRun(projectId, queued.id, {
      status: "completed",
      finishedAt: now(),
      spend: { usd: meter.usd, reservedUsd: reserved, reserved: false },
      ...(capped ? { error: NIGHTLY_CAP_ERROR } : {}),
    });
    logger.info(
      {
        project_id: projectId,
        run_id: queued.id,
        n_evals: evals.length,
        n_failed: results.filter((r) => r.passed === false).length,
        spend_usd: meter.usd,
        reserved_usd: reserved,
      },
      "eval_run_finished",
    );
    await (deps.observability ?? createBackgroundObservability()).trackSystemEvent(
      "eval_run_finished",
      EVAL_ACTOR,
      {
        object_action: "eval_run_finished",
        project_id: projectId,
        run_id: queued.id,
        status: "completed",
        eval_count: evals.length,
      },
    );
    return { ran: true, status: "completed", runId: queued.id };
  } catch (err) {
    logger.error({ err, project_id: projectId, run_id: queued.id }, "eval run failed");
    await store.updateRun(projectId, queued.id, {
      status: "failed",
      finishedAt: now(),
      error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      spend: { usd: meter.usd, reservedUsd: reserved, reserved: false },
    });
    throw err;
  }
}

/** One replay's result row: its verdicts and numbers, its tool answers, and its text when `keepText`. No `change`: the caller compares. */
export function scoredResult(
  evalId: string,
  outcome: RecordedReplayOutcome,
  scorers: readonly Scorer[],
  keepText: boolean,
  elapsedMs: number,
): NewEvalResult {
  const toolAnswers = (outcome.trace?.answers ?? []).map(({ tool, source, reason, ms }) => ({
    tool,
    source,
    reason,
    ms,
  }));
  const transcript =
    keepText && outcome.trace?.transcript
      ? { toolsOffered: outcome.trace.toolsOffered, steps: outcome.trace.transcript }
      : null;
  if (!outcome.ok)
    return {
      evalId,
      passed: null,
      verdicts: [],
      toolAnswers,
      transcript,
      error: outcome.reason,
      durationMs: elapsedMs,
    };
  const { verdicts, passed } = verdictsOf(outcome.view, scorers);
  return {
    evalId,
    passed,
    verdicts,
    durationMs: outcome.view.latencyMs ?? null,
    costUsd: outcome.view.costUsd ?? null,
    toolCalls: outcome.view.calls?.length ?? null,
    toolAnswers,
    transcript,
  };
}

/**
 * RC-613: the user's own scorers for each eval: its tasks' scorers and the
 * suite's, after the eval's own switches.
 */
async function userScorersFor(
  projectId: string,
  evalIds: readonly string[],
  db: ReturnType<typeof getDb>,
) {
  const repo = drizzleScorerRepository(db);
  const all = await repo.list(projectId);
  const overrides = await repo.overrides(projectId, evalIds);
  const suite = all.filter((scorer) => scorer.scope === "suite");
  const byTask = new Map<string, UserScorer[]>();
  for (const scorer of all)
    if (scorer.scope === "task" && scorer.taskId)
      byTask.set(scorer.taskId, [...(byTask.get(scorer.taskId) ?? []), scorer]);
  return {
    byId: new Map(all.map((scorer) => [scorer.id, scorer])),
    anyDecision: all.some((scorer) => scorer.kind === "decision"),
    forEval: (evalId: string, tasks: readonly string[]) =>
      applicableScorers(
        [...new Set(tasks)].flatMap((task) => byTask.get(task) ?? []),
        suite,
        overrides.get(evalId),
      ),
  };
}

/** Claim the queued run and hold its model budget, under the same organization lock as other simulations. Null when another worker has it. */
export async function reserveEvalRun(
  run: EvalRun,
  capUsd: number,
  dailyBudgetUsd: number,
  db: ReturnType<typeof getDb>,
  now: Date,
): Promise<number | null> {
  return db.transaction(async (tx) => {
    // Owned: the core has no organizations table; the advisory lock on the organization stands in.
    if (!(await lockOrganizationSpend(run.projectId, tx)))
      throw new Error("The eval run's project does not exist.");
    const spent = await organizationModelSpendSince(
      run.projectId,
      new Date(now.getTime() - 86_400_000),
      tx,
    );
    const reserved = Math.max(0, Math.min(capUsd, dailyBudgetUsd - spent));
    const [claimed] = await tx
      .update(evalRuns)
      .set({
        status: "running",
        startedAt: now,
        spend: { usd: reserved, reservedUsd: reserved, reserved: true },
      })
      .where(and(eq(evalRuns.id, run.id), eq(evalRuns.status, "queued")))
      .returning({ id: evalRuns.id });
    return claimed ? reserved : null;
  });
}

/**
 * Owned: the plan is the entitlements port's, for the organization the session port knows (the
 * edition owns `organizations`); one it does not know is decided by its id alone.
 */
export async function organizationPaid(
  projectId: string,
  db: ReturnType<typeof getDb>,
): Promise<boolean> {
  const [project] = await db
    .select({ organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return false;
  const organization = await getOrganizationById(project.organizationId).catch(() => null);
  return hasPaidPlan(organization ?? { id: project.organizationId });
}

export async function loadEvalReplays(
  projectId: string,
  turnIds: readonly string[],
  db: ReturnType<typeof getDb>,
): Promise<Map<string, EvalReplay>> {
  const records = await loadRuns(projectId, turnIds, db);
  const calls = await loadModelCalls(
    projectId,
    [...records.values()].map((record) => ({
      turnId: record.turnId,
      startedAt: new Date(record.startedAt),
      endedAt: new Date(record.endedAt ?? record.startedAt),
      traceIds: record.traceIds ?? [],
    })),
    { withPayload: true },
    db,
  );
  return new Map(
    [...records].map(([turnId, run]) => [turnId, { run, calls: calls.get(turnId) ?? [] }]),
  );
}
