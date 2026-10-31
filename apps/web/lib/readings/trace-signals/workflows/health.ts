import { median, quantile } from "@/lib/readings/trace-signals/signals/severity";
import type { TurnSourceMix } from "@/lib/readings/trace-signals/view";
import type {
  Workflow,
  WorkflowExample,
  WorkflowHealth,
  WorkflowModelHealth,
  WorkflowSlowStep,
  WorkflowStepShare,
  WorkflowTurn,
} from "@/lib/readings/trace-signals/workflows/types";
import { toolCalls } from "@/lib/readings/trace-signals/workflows/units";

/**
 * How a workflow's runs went, from the closed turns placed in it. Pure: times
 * come from the turns (`endedAt - startedAt`, steps' `tookMs`), never the clock.
 *
 * - A run fails when its last tool call ended in `error` (`InvokeOutcome`
 *   "error"); "unknown" (no end seen) is not a failure. The failing step is
 *   the tool with the most such terminal errors, as a share of failed runs.
 * - The slowest step is the tool with the largest share of summed `tookMs`
 *   across member runs (calls without `tookMs` add nothing).
 * - A retry run called the same tool twice or more in a row among its tool
 *   calls (searches in between do not break the row).
 * Only tool calls count (skills excluded), as in mining.
 * - Runs linked to OpenTelemetry model calls also say what a run costs, how
 *   many model calls it makes and what share of its time is in the model.
 */

export const WORKFLOW_EVIDENCE_TURNS = 5;

interface RunReading {
  turn: WorkflowTurn;
  durationMs: number;
  calls: number;
  /** The tool whose call ended the run in error, and that step. */
  failedAt: { toolId: string; traceEventId: string } | null;
  errored: boolean;
  retried: boolean;
  took: readonly { toolId: string; ms: number }[];
}

function readRun(turn: WorkflowTurn): RunReading {
  const calls = toolCalls(turn);
  const last = calls[calls.length - 1];
  return {
    turn,
    durationMs: Math.max(0, turn.endedAt.getTime() - turn.startedAt.getTime()),
    calls: calls.length,
    failedAt:
      last?.outcome === "error" ? { toolId: last.targetId, traceEventId: last.traceEventId } : null,
    errored: calls.some((call) => call.outcome === "error"),
    retried: calls.some((call, i) => i > 0 && calls[i - 1]!.targetId === call.targetId),
    took: calls.flatMap((call) =>
      call.tookMs === null || call.tookMs === undefined
        ? []
        : [{ toolId: call.targetId, ms: call.tookMs }],
    ),
  };
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function topShare(counts: ReadonlyMap<string, number>): WorkflowStepShare | null {
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const ranked = [...counts].sort(([a, x], [b, y]) => y - x || byId(a, b));
  const top = ranked[0];
  return top && total > 0 ? { toolId: top[0], count: top[1], share: top[1] / total } : null;
}

function tally(keys: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const key of keys) out.set(key, (out.get(key) ?? 0) + 1);
  return out;
}

function slowestStep(runs: readonly RunReading[]): WorkflowSlowStep | null {
  const took = runs.flatMap((run) => run.took);
  const summed = new Map<string, number>();
  for (const { toolId, ms } of took) summed.set(toolId, (summed.get(toolId) ?? 0) + ms);
  const top = topShare(summed);
  if (!top) return null;
  return { ...top, medianMs: median(took.filter((t) => t.toolId === top.toolId).map((t) => t.ms)) };
}

function mixOf(runs: readonly RunReading[]): TurnSourceMix {
  const counts = tally(runs.map((run) => run.turn.turnSource));
  return {
    declared: counts.get("declared") ?? 0,
    inferred: counts.get("inferred") ?? 0,
    otlp: counts.get("otlp") ?? 0,
  };
}

const newest = (a: RunReading, b: RunReading) =>
  b.turn.endedAt.getTime() - a.turn.endedAt.getTime() || byId(a.turn.id, b.turn.id);

function examples(runs: readonly RunReading[], limit: number) {
  const failed = runs
    .filter((run) => run.failedAt)
    .sort(newest)
    .slice(0, limit);
  const slow = [...runs]
    .sort((a, b) => b.durationMs - a.durationMs || newest(a, b))
    .slice(0, limit);
  const recent = [...runs].sort(newest).slice(0, limit);
  const plain = (run: RunReading): WorkflowExample => ({ turnId: run.turn.id, traceEventId: null });
  return {
    failedExamples: failed.map((run) => ({
      turnId: run.turn.id,
      traceEventId: run.failedAt!.traceEventId,
    })),
    slowExamples: slow.map(plain),
    recentExamples: recent.map(plain),
  };
}

/** What the runs linked to model calls spent in the model; null without such runs. */
export function modelHealth(turns: readonly WorkflowTurn[]): WorkflowModelHealth | null {
  const models = turns.flatMap((turn) => (turn.model ? [turn.model] : []));
  if (models.length === 0) return null;
  const costs = models.flatMap((model) => (model.costUsd === null ? [] : [model.costUsd]));
  const runMs = models.reduce((sum, model) => sum + model.runMs, 0);
  const modelMs = models.reduce((sum, model) => sum + model.modelMs, 0);
  return {
    runs: models.length,
    medianCostUsd: median(costs),
    medianModelCalls: median(models.map((model) => model.calls)) ?? 0,
    modelShare: runMs > 0 ? Math.min(1, modelMs / runMs) : 0,
  };
}

export function workflowHealth(
  workflow: Pick<Workflow, "id" | "memberTurnIds">,
  turnsById: ReadonlyMap<string, WorkflowTurn>,
  evidenceTurns: number = WORKFLOW_EVIDENCE_TURNS,
): WorkflowHealth {
  const runs = workflow.memberTurnIds.flatMap((id) => {
    const turn = turnsById.get(id);
    return turn ? [readRun(turn)] : [];
  });
  const failures = runs.flatMap((run) => (run.failedAt ? [run.failedAt.toolId] : []));
  const durations = runs.map((run) => run.durationMs);
  const n = runs.length;
  const model = modelHealth(runs.map((run) => run.turn));
  return {
    workflowId: workflow.id,
    runs: n,
    completedRuns: n - failures.length,
    completion: n > 0 ? (n - failures.length) / n : 0,
    failedRuns: failures.length,
    failingStep: topShare(tally(failures)),
    medianMs: median(durations),
    p95Ms: quantile(durations, 0.95),
    slowestStep: slowestStep(runs),
    retryRuns: runs.filter((run) => run.retried).length,
    errorRuns: runs.filter((run) => run.errored).length,
    meanToolCalls: n > 0 ? runs.reduce((sum, run) => sum + run.calls, 0) / n : 0,
    turnSourceMix: mixOf(runs),
    ...examples(runs, evidenceTurns),
    ...(model ? { model } : {}),
  };
}
