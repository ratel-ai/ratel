import { and, eq } from "drizzle-orm";
import { loadToolCorpus } from "@/lib/ingest/runtime-catalog/inventory";
import { createBackgroundObservability } from "@/lib/jobs/observability";
import { getDb } from "@/lib/platform/db/client";
import { getLogger, runWithLogContext } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";
import { loadModelCalls } from "@/lib/views/eval-gate/calls";
import { parseExpected } from "@/lib/views/eval-gate/defaults";
import { EVAL_GATE_OFF_ERROR, evalGateEnabledForActor } from "@/lib/views/eval-gate/gate";
import { parseSimulatePayload } from "@/lib/views/eval-gate/job";
import { methodForKind } from "@/lib/views/eval-gate/method";
import {
  DAILY_ORG_BUDGET_USD,
  JUDGE_BUDGET_USD,
  REPLAY_BUDGET_USD,
  resolveEvalModels,
} from "@/lib/views/eval-gate/models";
import { createRanker } from "@/lib/views/eval-gate/ranker";
import { loadRuns } from "@/lib/views/eval-gate/runs";
import { summarize } from "@/lib/views/eval-gate/score";
import { loadCatalogToolDefs } from "@/lib/views/eval-gate/service";
import { type SimulationCase, simulateCases } from "@/lib/views/eval-gate/simulation";
import { type Expected, NO_EXPECTATION, type Tally } from "@/lib/views/eval-gate/types";
import { type TaskEvalRunRow, taskEvalRuns } from "@/lib/views/task-evals/schema";
import { SCORER_VERSION } from "@/lib/views/task-scorers/engine";
import { scorersFor } from "@/lib/views/task-scorers/store";
import type { Scorer, ScorerResult } from "@/lib/views/task-scorers/types";
import { measurePostShip } from "./post-ship";
import { reserveTaskSimulation, type TaskSimulationDeps } from "./simulation";
import { taskEvalSetFor } from "./store";

export type ScorerComparison = Record<string, { before: Tally; after: Tally }>;
type Scores = { caseId: string; before: ScorerResult[]; after: ScorerResult[] };
const logger = getLogger("task-evals/simulation-job");

/** Simulate one task with its live scorer engine and the queued draft. */
export async function simulateTaskEvalJob(
  projectId: string,
  payload: unknown,
  deps: TaskSimulationDeps = {},
) {
  const parsed = parseSimulatePayload(payload);
  if (!parsed) return { simulated: false, reason: "invalid_payload" };
  const db = deps.db ?? getDb();
  const [queued] = await db
    .select()
    .from(taskEvalRuns)
    .where(and(eq(taskEvalRuns.id, parsed.runId), eq(taskEvalRuns.projectId, projectId)));
  if (!queued) return { simulated: false, reason: "run_not_found" };
  if (queued.status !== "queued")
    return { simulated: queued.status === "completed", status: queued.status };
  if (!(await evalGateEnabledForActor(projectId, queued.createdBy, db, deps.flagDeps))) {
    await db
      .update(taskEvalRuns)
      .set({ status: "failed", error: EVAL_GATE_OFF_ERROR, finishedAt: new Date() })
      .where(and(eq(taskEvalRuns.id, queued.id), eq(taskEvalRuns.status, "queued")));
    return { simulated: false, reason: "gate_off" };
  }
  if (queued.kind === "post_ship")
    return measurePostShip(queued, db, deps.now?.() ?? new Date(), deps);
  if (queued.kind !== "simulation") return { simulated: false, reason: "unsupported_kind" };
  const models = deps.models ?? resolveEvalModels(undefined, "eval_gate_task_judge");
  const replayUsd = deps.replayBudgetUsd ?? REPLAY_BUDGET_USD;
  const judgeUsd = deps.judgeBudgetUsd ?? JUDGE_BUDGET_USD;
  const reserved = await reserveTaskSimulation(
    queued,
    (models.agent ? replayUsd : 0) + (models.judge ? judgeUsd : 0),
    deps.dailyBudgetUsd ?? DAILY_ORG_BUDGET_USD,
    deps,
  );
  if (!reserved) return { simulated: false, reason: "already_claimed" };
  return runWithLogContext({ project_id: projectId, org_id: reserved.organizationId }, async () => {
    const run = reserved.run;
    try {
      if (run.scorerVersion !== SCORER_VERSION)
        throw new Error("The scorer engine changed. Run the simulation again.");
      const { cases } = await taskEvalSetFor(projectId, run.taskId, db);
      const active = cases.filter(
        (item) => item.excludedAt === null && (item.fixId === null || item.fixId === run.fixId),
      );
      const scorers =
        (run.change?.scorers as Scorer[] | undefined) ??
        (await scorersFor(projectId, run.taskId, db)).filter((scorer) => scorer.enabled);
      const records = await loadRuns(
        projectId,
        active.map((item) => item.turnId),
        db,
      );
      const change = reserved.change;
      const kind = typeof run.change?.kind === "string" ? run.change.kind : "";
      const method = methodForKind(kind);
      const calls =
        method === "replay"
          ? await loadModelCalls(
              projectId,
              [...records.values()].map((record) => ({
                turnId: record.turnId,
                startedAt: new Date(record.startedAt),
                endedAt: new Date(record.endedAt ?? record.startedAt),
                traceIds: record.traceIds ?? [],
              })),
              { withPayload: true },
              db,
            )
          : new Map();
      const prepared: SimulationCase[] = active.map((item, position) => ({
        id: item.id,
        turnId: item.turnId,
        traceId: records.get(item.turnId)?.traceId ?? null,
        origin: "task",
        originRef: null,
        position,
        outcome: "",
        criteria: item.criteria,
        expected:
          item.fixId || item.origin === "user"
            ? parseExpected({ ...expectedFor(scorers), ...item.expected })
            : expectedFor(scorers),
        role: item.fixId ? "evidence" : "holdout",
        run: records.get(item.turnId) ?? null,
        calls: calls.get(item.turnId) ?? [],
        scorers,
      }));
      const simulation = await simulateCases(
        prepared,
        {
          ...change,
          kind,
          ranker:
            method === "rerank" ? createRanker(await loadToolCorpus(projectId, db), change) : null,
          toolDefs: change.replay?.skill
            ? await loadCatalogToolDefs(projectId, change.replay.skill.steps, db)
            : undefined,
        },
        models,
        {
          dailyLeftUsd: reserved.dailyLeftUsd,
          replayUsd,
          judgeUsd,
          judgeFeature: "eval_gate_task_judge",
        },
      );
      const taskIds = new Set(active.filter((item) => item.fixId === null).map((item) => item.id));
      const scores = simulation.scorerResults ?? [];
      const breakdown = {
        task: compareScorers(
          scores.filter((item) => taskIds.has(item.caseId)),
          scorers,
        ),
        fix: compareScorers(
          scores.filter((item) => !taskIds.has(item.caseId)),
          scorers,
        ),
      };
      const summary = summarize(simulation.results, run.id, change.unsupportedReason !== null);
      const [completed] = await db
        .update(taskEvalRuns)
        .set({
          status: "completed",
          before: { ...summary.before },
          after: { ...summary.after },
          verdict: summary.verdict,
          breakdown,
          results: simulation.results.map((result) => ({
            ...result,
            scorers: scores.find((item) => item.caseId === result.caseId) ?? null,
          })),
          methods: { ...simulation.methods },
          spend: simulation.spend ? { ...simulation.spend } : null,
          judge: { ...simulation.judge.status },
          caseCount: taskIds.size,
          fixCaseCount: active.length - taskIds.size,
          finishedAt: deps.now?.() ?? new Date(),
        })
        .where(and(eq(taskEvalRuns.id, run.id), eq(taskEvalRuns.status, "running")))
        .returning();
      logFinished(completed ?? run, simulation.method, reserved.organizationId, summary.nSimulated);
      await (deps.observability ?? createBackgroundObservability()).trackSystemEvent(
        "task_eval_simulation_finished",
        "system:task-evals",
        {
          object_action: "task_eval_simulation_finished",
          project_id: projectId,
          task_id: run.taskId,
          fix_id: run.fixId,
          run_id: run.id,
          status: "completed",
        },
      );
      return { simulated: true, status: "completed", runId: run.id };
    } catch (err) {
      logger.error(
        { err, project_id: projectId, task_id: run.taskId, run_id: run.id },
        "task eval simulation failed",
      );
      reportServerException(err, "system:task-evals", {
        project_id: projectId,
        operation: "task_eval_simulation",
      });
      const [failed] = await db
        .update(taskEvalRuns)
        .set({
          status: "failed",
          error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
          finishedAt: new Date(),
        })
        .where(and(eq(taskEvalRuns.id, run.id), eq(taskEvalRuns.status, "running")))
        .returning();
      logFinished(failed ?? run, null, reserved.organizationId, 0);
      throw err;
    }
  });
}

function expectedFor(scorers: readonly Scorer[]): Expected {
  const expected = { ...NO_EXPECTATION };
  for (const scorer of scorers) {
    switch (scorer.kind) {
      case "expected_tool":
        expected.tool = scorer.tool;
        break;
      case "ends_well":
        expected.endsWell = true;
        break;
      case "max_self_corrections":
        expected.maxSelfCorrections = scorer.max;
        break;
      case "max_latency_ms":
        expected.maxLatencyMs = scorer.max;
        break;
      case "max_cost_usd":
        expected.maxCostUsd = scorer.max;
        break;
      case "max_tool_calls":
        expected.maxToolCalls = scorer.max;
        break;
    }
  }
  return expected;
}

function compareScorers(results: readonly Scores[], scorers: readonly Scorer[]): ScorerComparison {
  return Object.fromEntries(
    scorers.map((scorer) => {
      const pairs = results.flatMap((item) => {
        const before = item.before.find((result) => result.kind === scorer.kind);
        const after = item.after.find((result) => result.kind === scorer.kind);
        return before && after && before.status !== "skip" && after.status !== "skip"
          ? [{ before, after }]
          : [];
      });
      return [
        scorer.kind,
        {
          before: tally(pairs.map((pair) => pair.before)),
          after: tally(pairs.map((pair) => pair.after)),
        },
      ];
    }),
  );
}

function tally(results: readonly ScorerResult[]): Tally {
  const passed = results.filter((result) => result.status === "pass").length;
  return {
    passed,
    total: results.length,
    passRate: results.length ? passed / results.length : null,
    score: results.length
      ? results.reduce((sum, result) => sum + result.score, 0) / results.length
      : null,
  };
}

function logFinished(
  run: TaskEvalRunRow,
  method: string | null,
  organizationId: string,
  simulated: number,
) {
  logger.info(
    {
      run_id: run.id,
      set_id: run.taskId,
      project_id: run.projectId,
      organization_id: organizationId,
      task_id: run.taskId,
      fix_id: run.fixId,
      trigger: run.trigger,
      status: run.status,
      verdict: run.verdict,
      method,
      n_cases: run.caseCount,
      fix_case_count: run.fixCaseCount,
      n_simulated: simulated,
      scorer_version: run.scorerVersion,
      methods_replay: run.methods?.replay ?? 0,
      methods_rerank: run.methods?.rerank ?? 0,
      methods_none: run.methods?.none ?? 0,
      spend_usd: run.spend?.usd ?? 0,
      spend_calls: run.spend?.calls ?? 0,
      duration_ms: Math.max(0, Date.now() - (run.startedAt ?? run.createdAt).getTime()),
    },
    "task_eval_simulation_finished",
  );
}
