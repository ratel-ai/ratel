import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { loadModelCalls, type ModelCall } from "@/lib/views/eval-gate/calls";
import {
  DAILY_ORG_BUDGET_USD,
  type JudgeModel,
  resolveTaskJudge,
  SpendMeter,
} from "@/lib/views/eval-gate/models";
import { organizationModelSpendSince } from "@/lib/views/eval-gate/store";
import type { RunRecord as TraceRun } from "@/lib/views/eval-gate/types";
import { TASK_JUDGE_BUDGET_USD, TASK_JUDGE_SAMPLE } from "@/lib/views/task-scorers/judge";
import {
  type DecisionEngineFactory,
  decisionEngineFromEnv,
  decisionPortOf,
  meteredJudgePort,
} from "./adapters/models";
import { recordFromTrace } from "./adapters/run-record";
import {
  type RunScoreInput,
  readingsOnDay,
  saveRunScores,
  scoredTurns,
} from "./adapters/run-scores";
import { drizzleScorerRepository } from "./adapters/store";
import { scoreRecord } from "./domain/engine";
import type { Scorer } from "./domain/types";

/**
 * RC-613: the score job's pass with the user's own scorers. Each enabled task
 * scorer reads each closed run once per scorer version. Deterministic kinds
 * read every run; model-based kinds read at most `TASK_JUDGE_SAMPLE` runs per
 * scorer per day, inside the task judge budget and the organization's daily
 * model budget. Runs whose readings are all current are not loaded again.
 * The caller enforces the `cloud-eval-gate` flag.
 */

export interface LiveScoringDeps {
  judge?: JudgeModel | null;
  decision?: DecisionEngineFactory | null;
  sample?: number;
  judgeBudgetUsd?: number;
  dailyBudgetUsd?: number;
  loadCalls?: (projectId: string, runs: readonly TraceRun[]) => Promise<Map<string, ModelCall[]>>;
}

const logger = getLogger("scorers/live");
const MODEL_KINDS = new Set<Scorer["kind"]>(["judge", "decision"]);

/** The task's enabled user scorers. Empty when the task has none: the old engine alone scores it. */
export async function liveTaskScorers(
  projectId: string,
  taskId: string,
  db: ReturnType<typeof getDb> = getDb(),
): Promise<Scorer[]> {
  return (await drizzleScorerRepository(db).list(projectId, { taskId, scope: "task" })).filter(
    (scorer) => scorer.enabled,
  );
}

/** Score one day's runs of one task with its user scorers and store each reading. */
export async function scoreLiveRuns(
  projectId: string,
  scorers: readonly Scorer[],
  runs: readonly TraceRun[],
  day: string,
  now: Date,
  db: ReturnType<typeof getDb> = getDb(),
  deps: LiveScoringDeps = {},
) {
  const counts = { scored: 0, readings: 0 };
  if (scorers.length === 0 || runs.length === 0) return counts;
  const done = await scoredTurns(
    projectId,
    scorers,
    runs.map((run) => run.turnId),
    db,
  );
  const modelScorers = scorers.filter((scorer) => MODEL_KINDS.has(scorer.kind));
  const used = await readingsOnDay(
    projectId,
    modelScorers.map((scorer) => scorer.id),
    day,
    db,
  );
  const sample = Math.max(0, Math.floor(deps.sample ?? TASK_JUDGE_SAMPLE));
  const room = new Map(
    modelScorers.map((scorer) => [scorer.id, Math.max(0, sample - (used.get(scorer.id) ?? 0))]),
  );
  const ordered = [...runs].sort((a, b) => a.turnId.localeCompare(b.turnId));
  // Which scorers read which run: every scorer that has not read it, model ones while their sample has room.
  const plan = new Map<string, Scorer[]>();
  for (const run of ordered) {
    const due = scorers.filter((scorer) => {
      if (done.get(scorer.id)!.has(run.turnId)) return false;
      if (!MODEL_KINDS.has(scorer.kind)) return true;
      const left = room.get(scorer.id)!;
      if (left <= 0) return false;
      room.set(scorer.id, left - 1);
      return true;
    });
    if (due.length > 0) plan.set(run.turnId, due);
  }
  if (plan.size === 0) return counts;
  const planned = ordered.filter((run) => plan.has(run.turnId));
  const calls = await (deps.loadCalls ?? ((id, list) => loadCallsOf(id, list, db)))(
    projectId,
    planned,
  );
  const ports = await modelPorts(projectId, plan, now, db, deps);
  const inputs: RunScoreInput[] = [];
  for (const run of planned) {
    const due = plan.get(run.turnId)!;
    const results = await scoreRecord(
      recordFromTrace(run, calls.get(run.turnId) ?? []),
      due,
      ports,
    );
    results.forEach((result, index) =>
      inputs.push({ scorer: due[index]!, result, day, turnId: run.turnId }),
    );
    counts.scored++;
  }
  await saveRunScores(projectId, inputs, db);
  counts.readings = inputs.length;
  logger.info(
    { project_id: projectId, day, runs: counts.scored, readings: counts.readings },
    "user scorers read live runs",
  );
  return counts;
}

async function modelPorts(
  projectId: string,
  plan: ReadonlyMap<string, Scorer[]>,
  now: Date,
  db: ReturnType<typeof getDb>,
  deps: LiveScoringDeps,
) {
  const kinds = new Set([...plan.values()].flat().map((scorer) => scorer.kind));
  const ports: Parameters<typeof scoreRecord>[2] = {};
  if (kinds.has("judge")) {
    const judge = deps.judge === undefined ? resolveTaskJudge() : deps.judge;
    if (judge) {
      const spent = await organizationModelSpendSince(
        projectId,
        new Date(now.getTime() - 86_400_000),
        db,
      );
      const cap = Math.max(
        0,
        Math.min(
          deps.judgeBudgetUsd ?? TASK_JUDGE_BUDGET_USD,
          (deps.dailyBudgetUsd ?? DAILY_ORG_BUDGET_USD) - spent,
        ),
      );
      ports.judge = meteredJudgePort(judge, new SpendMeter(cap), "eval_gate_task_judge");
    }
  }
  if (kinds.has("decision")) {
    const factory = deps.decision === undefined ? decisionEngineFromEnv() : deps.decision;
    if (factory) ports.decision = decisionPortOf(factory);
  }
  return ports;
}

async function loadCallsOf(
  projectId: string,
  runs: readonly TraceRun[],
  db: ReturnType<typeof getDb>,
) {
  return loadModelCalls(
    projectId,
    runs.map((run) => ({
      turnId: run.turnId,
      startedAt: new Date(run.startedAt),
      endedAt: new Date(run.endedAt ?? run.startedAt),
      traceIds: run.traceIds ?? [],
    })),
    { withPayload: true },
    db,
  );
}
