import { rebaseScorers, scoreReplaySide } from "@/lib/views/task-scorers/replay";
import type { Scorer, ScorerResult } from "@/lib/views/task-scorers/types";
import type { ModelCall } from "./calls";
import { draftedLimit, rebasedForReplay } from "./defaults";
import { type JudgeItem, type JudgeResult, judgeCriteria } from "./judge";
import { CANT_SIMULATE, methodForKind, replayGap } from "./method";
import {
  type EvalGateFeature,
  type EvalModels,
  JUDGE_BUDGET_USD,
  REPLAY_BUDGET_USD,
  REPLAY_MAX_STEPS,
  recordBudgetRefusal,
  recordNoModelKey,
  SpendMeter,
} from "./models";
import { replayRun } from "./replay";
import { methodTally, scoreCase } from "./score";
import { affects, type Ranker, simulateRun } from "./simulate";
import type {
  CaseResult,
  CaseRole,
  EvalCase,
  FixChange,
  MethodTally,
  ModelSpend,
  RunRecord,
  RunView,
  SimMethod,
  ToolDef,
} from "./types";

export interface SimulationCase extends EvalCase {
  run: RunRecord | null;
  calls?: readonly ModelCall[];
  role: CaseRole;
  /** The task's scorers; `source: "default"` marks a drafted one. */
  scorers?: readonly (Scorer & { source?: string })[];
}

export interface SimulationChange extends FixChange {
  kind: string;
  ranker?: Ranker | null;
  toolDefs?: ReadonlyMap<string, ToolDef>;
}

export interface SimulationBudget {
  /** The remaining organization budget for the current day, in USD. */
  dailyLeftUsd: number;
  replayUsd?: number;
  judgeUsd?: number;
  judgeFeature?: EvalGateFeature;
  maxSteps?: number;
}

export interface CaseSimulation {
  results: CaseResult[];
  method: SimMethod;
  methods: MethodTally;
  spend: ModelSpend | null;
  judge: JudgeResult;
  scorerResults?: { caseId: string; before: ScorerResult[]; after: ScorerResult[] }[];
}

type Simulated =
  | {
      kind: "scored";
      before: RunView;
      after: RunView;
      method: SimMethod;
      note: string | null;
      replay: CaseResult["replay"];
      reranked?: boolean;
    }
  | { kind: "skipped"; result: CaseResult };

/** Runs replayed at once. */
const REPLAY_CONCURRENCY = 4;

/** Simulate prepared cases without an eval set or database access. */
export async function simulateCases(
  cases: readonly SimulationCase[],
  change: SimulationChange,
  models: EvalModels,
  budget: SimulationBudget,
): Promise<CaseSimulation> {
  const method: SimMethod = change.unsupportedReason ? "none" : methodForKind(change.kind);
  const dailyLeft = Math.max(0, budget.dailyLeftUsd);
  const dailySpent = dailyLeft <= 0;
  const replayCap = budget.replayUsd ?? REPLAY_BUDGET_USD;
  const replayMeter = new SpendMeter(Math.min(replayCap, dailyLeft));
  const replayBlocked =
    method !== "replay"
      ? null
      : !models.agent
        ? CANT_SIMULATE.noModel
        : dailySpent
          ? CANT_SIMULATE.dailyBudget
          : replayGap(change.kind, change);
  const halt = { reason: null as string | null };

  const skip = (
    item: EvalCase,
    skipped: CaseResult["skipped"],
    note: string | null = null,
  ): Simulated => ({
    kind: "skipped",
    result: {
      caseId: item.id,
      turnId: item.turnId,
      simulated: false,
      skipped,
      before: null,
      after: null,
      method: "none",
      methodNote: note,
    },
  });
  let blockedReplays = 0;
  const simulateOne = async (item: SimulationCase): Promise<Simulated> => {
    const run = item.run;
    if (!run) return skip(item, "run-gone");
    if (method === "none")
      return skip(
        item,
        change.unsupportedReason ? "not-affected" : "cant-simulate",
        change.unsupportedReason ?? "Nothing a stored run records can show this kind of fix",
      );
    if (!affects(run, change)) return skip(item, "not-affected");
    if (method === "rerank") {
      const simulated = simulateRun(run, change, change.ranker ?? null, item.expected.tool);
      if (simulated.skipped) return skip(item, simulated.skipped);
      return {
        kind: "scored",
        before: simulated.before,
        after: simulated.after,
        method: "rerank",
        note: null,
        replay: null,
      };
    }
    if (replayBlocked) {
      blockedReplays += 1;
      return skip(item, "cant-simulate", replayBlocked);
    }
    const outcome = await replayRun(run, item.calls ?? [], change, {
      models,
      spend: replayMeter,
      maxSteps: budget.maxSteps ?? REPLAY_MAX_STEPS,
      toolDefs: change.toolDefs ?? new Map(),
      halt,
      ...(dailyLeft < replayCap ? { budgetNote: CANT_SIMULATE.dailyBudget } : {}),
    });
    if (!outcome.ok) {
      if (outcome.notAffected) return skip(item, "not-affected");
      const skipped = skip(item, "cant-simulate", outcome.reason);
      if (outcome.replayFailed && skipped.kind === "skipped") skipped.result.replayFailed = true;
      // RC-76: what the failed replay did, for the eval page.
      if (outcome.facts && skipped.kind === "skipped") skipped.result.replay = outcome.facts;
      return skipped;
    }
    return {
      kind: "scored",
      before: outcome.before,
      after: outcome.after,
      method: "replay",
      note: outcome.note,
      replay: outcome.facts,
    };
  };
  const simulated = await inPool(cases, method === "replay" ? REPLAY_CONCURRENCY : 1, simulateOne);
  // Record the number of replays blocked by the model configuration or daily budget.
  if (replayBlocked === CANT_SIMULATE.noModel) recordNoModelKey("eval_gate_replay", blockedReplays);
  else if (replayBlocked === CANT_SIMULATE.dailyBudget && models.agent && blockedReplays > 0) {
    const agent = models.agent({ recordedModel: null, recorded: [] });
    if (agent) recordBudgetRefusal(agent, "eval_gate_replay", blockedReplays);
  }

  // The person's words, judged on both sides by a model (or "not judged").
  const criteriaOf = (item: EvalCase) =>
    [item.outcome.trim(), item.criteria.trim()].filter(Boolean).join("\n");
  const items: JudgeItem[] = cases.flatMap((item, index) => {
    const sim = simulated[index]!;
    const criteria = criteriaOf(item);
    return sim.kind === "scored" && criteria
      ? [{ caseId: item.id, criteria, before: sim.before, after: sim.after }]
      : [];
  });
  const taskItems: JudgeItem[] = cases.flatMap((item, index) => {
    const sim = simulated[index]!;
    const scorer = item.scorers?.find((scorer) => scorer.kind === "judge_criteria");
    return sim.kind === "scored" && scorer?.kind === "judge_criteria"
      ? [
          {
            caseId: `task:${item.id}`,
            criteria: scorer.criteria,
            before: sim.before,
            after: sim.after,
          },
        ]
      : [];
  });
  items.push(...taskItems);
  // Limit the judge to the daily budget that remains after replay.
  const judgeMeter = new SpendMeter(
    Math.min(budget.judgeUsd ?? JUDGE_BUDGET_USD, Math.max(0, dailyLeft - replayMeter.usd)),
  );
  if (!models.judge) recordNoModelKey(budget.judgeFeature ?? "eval_gate_judge", items.length);
  if (dailySpent && models.judge)
    recordBudgetRefusal(models.judge, budget.judgeFeature ?? "eval_gate_judge", items.length);
  const judged =
    dailySpent && models.judge && items.length > 0
      ? {
          readings: new Map(items.map((item) => [item.caseId, { before: null, after: null }])),
          status: {
            status: "budget" as const,
            model: models.judge.model,
            runs: 0,
            skipped: items.length,
          },
        }
      : await judgeCriteria(items, models.judge, judgeMeter, budget.judgeFeature);

  const results: CaseResult[] = cases.map((item, index) => {
    const role = item.role;
    const sim = simulated[index]!;
    if (sim.kind === "skipped") return { ...sim.result, role };
    const reading = judged.readings.get(item.id);
    // RC-76: a replay's drafted cost and time limits are read against its own baseline.
    const expected =
      sim.method === "replay" && item.run
        ? rebasedForReplay(
            item.expected,
            item.run,
            sim.before,
            draftedLimit(item.run, item.scorers),
          )
        : item.expected;
    const taskReading = judged.readings.get(`task:${item.id}`);
    const scored = scoreCase(
      { ...item, expected },
      { before: sim.before, after: sim.after, skipped: null, reranked: sim.reranked ?? false },
      change,
      {
        ...(reading ? { criteria: reading } : {}),
        ...(taskReading ? { taskCriteria: taskReading } : {}),
      },
    );
    return {
      ...scored,
      role,
      method: scored.simulated ? sim.method : "none",
      methodNote: scored.methodNote ?? sim.note,
      replay: sim.replay ?? null,
    };
  });
  const spend = spendOf(
    [replayMeter, judgeMeter],
    replayMeter.capUsd + judgeMeter.capUsd,
    replayMeter.exhausted || judgeMeter.exhausted,
  );
  // RC-76: the per-scorer results read a replay side by the verdict's rules: the same rebased limits, and a side short of the run's work fails.
  const scorerResults = cases.flatMap((item, index) => {
    const sim = simulated[index]!;
    if (!item.scorers || sim.kind !== "scored") return [];
    const scorers =
      sim.method === "replay" && item.run
        ? rebaseScorers(item.scorers, sim.before, draftedLimit(item.run, item.scorers))
        : item.scorers;
    const reading = judged.readings.get(`task:${item.id}`);
    return [
      {
        caseId: item.id,
        before: scoreReplaySide({ ...sim.before, criteriaPass: reading?.before }, scorers),
        after: scoreReplaySide({ ...sim.after, criteriaPass: reading?.after }, scorers),
      },
    ];
  });
  return {
    results,
    method,
    methods: methodTally(results),
    spend,
    judge: judged,
    ...(cases.some((item) => item.scorers) ? { scorerResults } : {}),
  };
}

/** Run `work` over `items`, at most `limit` at once, results in order. */
async function inPool<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await work(items[index]!);
    }
  });
  await Promise.all(lanes);
  return out;
}

function spendOf(
  meters: readonly SpendMeter[],
  capUsd: number,
  capped: boolean,
): ModelSpend | null {
  const calls = meters.reduce((sum, meter) => sum + meter.calls, 0);
  if (calls === 0) return null;
  return {
    usd: meters.reduce((sum, meter) => sum + meter.usd, 0),
    calls,
    inputTokens: meters.reduce((sum, meter) => sum + meter.inputTokens, 0),
    outputTokens: meters.reduce((sum, meter) => sum + meter.outputTokens, 0),
    capUsd,
    capped,
    models: [...new Set(meters.flatMap((meter) => [...meter.models]))],
  };
}
