import { SCORER_LABELS } from "@/lib/views/task-scorers/labels";
import type { TaskScorer } from "@/lib/views/task-scorers/store";
import type { Scorer as LegacyScorer, ScorerRun } from "@/lib/views/task-scorers/types";
import type { RunRecord, Scorer, ScorerDefinition } from "../domain/types";
import type { JudgePort } from "../ports";

/**
 * Old `task_scorers` rows and computed defaults (lib/task-scorers) read as
 * scorers of the new model, with the same pass and fail results. Ids are
 * stable per task and kind, so per-run results stay comparable.
 */

/** Read one old scorer, stored or default, as a new one. */
export function fromLegacy(
  taskId: string,
  scorer: LegacyScorer & Partial<Pick<TaskScorer, "enabled" | "version">>,
): Scorer {
  return {
    ...definitionOf(scorer),
    id: legacyScorerId(taskId, scorer.kind),
    name: SCORER_LABELS[scorer.kind],
    scope: "task",
    taskId,
    enabled: scorer.enabled ?? true,
    goodThreshold: 1,
    version: scorer.version ?? 1,
  };
}

export function legacyScorerId(taskId: string, kind: LegacyScorer["kind"]): string {
  return `legacy:${taskId}:${kind}`;
}

/** Read an old measured run as a run record. Message text, arguments and results are unknown. */
export function recordFromLegacyRun(run: ScorerRun): RunRecord {
  const calls = run.calls;
  return {
    messages: null,
    toolCalls: calls
      ? calls.map((name, index) => ({
          name,
          arguments: null,
          result: null,
          outcome: run.outcomes?.[index] ?? "unknown",
          latencyMs: null,
        }))
      : null,
    // An old run without one outcome per call cannot say how it ended.
    outcomesKnown: Boolean(calls && run.outcomes && run.outcomes.length === calls.length),
    finalAnswer: null,
    answered: run.answered ?? null,
    latencyMs: run.latencyMs ?? null,
    costUsd: run.costUsd ?? null,
    tokens: null,
    firstList: run.firstList,
    listKnown: run.listKnown,
  };
}

/** The old judge's stored verdict as a judge port: the criteria were judged before scoring. */
export function precomputedJudge(criteriaPass: boolean | null | undefined): JudgePort {
  return {
    judge: async () =>
      criteriaPass == null ? null : { value: criteriaPass ? 1 : 0, detail: "task criteria" },
  };
}

function definitionOf(scorer: LegacyScorer): ScorerDefinition {
  switch (scorer.kind) {
    case "ends_well":
      return { kind: "check", config: { path: "endsWell", op: "eq", value: true } };
    case "max_self_corrections":
      return { kind: "check", config: { path: "selfCorrections", op: "lte", value: scorer.max } };
    case "max_latency_ms":
      return { kind: "check", config: { path: "latencyMs", op: "lte", value: scorer.max } };
    case "max_cost_usd":
      return { kind: "check", config: { path: "costUsd", op: "lte", value: scorer.max } };
    case "max_tool_calls":
      return { kind: "check", config: { path: "toolCallCount", op: "lte", value: scorer.max } };
    case "expected_tool":
      return { kind: "check", config: { path: "firstList", op: "contains", value: scorer.tool } };
    case "judge_criteria":
      return { kind: "judge", config: { criteria: scorer.criteria } };
  }
}
