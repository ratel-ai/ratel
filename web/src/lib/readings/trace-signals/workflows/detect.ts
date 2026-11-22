import { median, wilsonLow } from "@/lib/readings/trace-signals/signals/severity";
import type { SignalEvidenceRef, SignalLane } from "@/lib/readings/trace-signals/signals/types";
import type { TurnSourceMix } from "@/lib/readings/trace-signals/view";
import { FIXED_ORDER } from "@/lib/readings/trace-signals/workflows/fixed-order";
import type {
  Workflow,
  WorkflowExample,
  WorkflowHealth,
  WorkflowSignal,
} from "@/lib/readings/trace-signals/workflows/types";

/**
 * Workflow signals, each phrased as something to do:
 *
 * - `workflow_failing`: completion at most `maxCompletion` over `minRuns`
 *   runs, and the Wilson lower bound of the failure share at least
 *   `minFailureLow`. Severity is that bound; impact is failed runs. Route
 *   `show_turns`: the failing step is named in the metrics.
 * - `workflow_slow`: median run time at least `minRatio` x the median of all
 *   workflows' medians, and at least `minMedianMs`. Severity is
 *   1 - baseline / median (the part of a typical run the baseline does not
 *   explain); impact is extra seconds over all runs. Route `show_turns`.
 * - `workflow_fixed_chain`: `minCoreSize`+ core tools first-called in the
 *   same order in at least `minOrderStability` of the runs that ran them all
 *   (the one fixed-order rule, `fixed-order.ts`, which the drafted fix reads
 *   too). Severity is the Wilson lower bound of that share; impact is the
 *   calls a composite tool would save (runs x (core size - 1)). Route
 *   `workflow_skill`.
 */

export interface WorkflowThresholds {
  readonly failing: {
    readonly minRuns: number;
    readonly maxCompletion: number;
    readonly minFailureLow: number;
  };
  readonly slow: {
    readonly minRuns: number;
    readonly minRatio: number;
    readonly minMedianMs: number;
  };
  readonly fixedChain: {
    readonly minRuns: number;
    readonly minCoreSize: number;
    readonly minOrderStability: number;
  };
}

export const WORKFLOW_THRESHOLDS: WorkflowThresholds = Object.freeze({
  failing: Object.freeze({ minRuns: 20, maxCompletion: 0.8, minFailureLow: 0.15 }),
  slow: Object.freeze({ minRuns: 20, minRatio: 3, minMedianMs: 5_000 }),
  fixedChain: Object.freeze({
    minRuns: FIXED_ORDER.minRuns,
    minCoreSize: FIXED_ORDER.minSteps,
    minOrderStability: FIXED_ORDER.minShare,
  }),
});

/** Same rules as `laneOf` / `round4` in `signals/build.ts`, kept local so this module does not load the signal catalog. */
function laneOf(mix: TurnSourceMix): SignalLane {
  const runtime = mix.declared + mix.inferred;
  if (mix.otlp > 0 && runtime > 0) return "mixed";
  return mix.otlp > 0 ? "otlp" : "runtime";
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

export interface WorkflowWithHealth {
  /** `id` is the subject key: pass the previous id `matchPrevious` mapped it to, if any. */
  workflow: Workflow;
  health: WorkflowHealth;
}

function evidence(
  examples: readonly WorkflowExample[],
  totalTurns: number,
  health: WorkflowHealth,
): SignalEvidenceRef {
  return {
    turnIds: examples.map((e) => e.turnId),
    traceEventIds: examples.map((e) => e.traceEventId),
    totalTurns,
    turnSourceMix: health.turnSourceMix,
  };
}

function subject({ workflow, health }: WorkflowWithHealth) {
  return {
    subjectKind: "workflow" as const,
    subjectKey: workflow.id,
    subjectIds: workflow.typicalOrder,
    entryKind: "tool" as const,
    lane: laneOf(health.turnSourceMix),
    n: health.runs,
  };
}

function failing(entry: WorkflowWithHealth, t: WorkflowThresholds["failing"]): WorkflowSignal[] {
  const { health } = entry;
  if (health.runs < t.minRuns || health.completion > t.maxCompletion) return [];
  const low = wilsonLow(health.failedRuns, health.runs);
  if (low < t.minFailureLow) return [];
  return [
    {
      kind: "workflow_failing",
      ...subject(entry),
      severity: round4(low),
      impact: health.failedRuns,
      route: "show_turns",
      metrics: {
        completion: round4(health.completion),
        runs: health.runs,
        failedRuns: health.failedRuns,
        failingStep: health.failingStep?.toolId ?? null,
        failingStepShare: health.failingStep ? round4(health.failingStep.share) : null,
      },
      evidence: evidence(health.failedExamples, health.failedRuns, health),
    },
  ];
}

function slow(
  entry: WorkflowWithHealth,
  baselineMs: number | null,
  t: WorkflowThresholds["slow"],
): WorkflowSignal[] {
  const { health } = entry;
  const medianMs = health.medianMs;
  if (health.runs < t.minRuns || medianMs === null || baselineMs === null || baselineMs <= 0)
    return [];
  if (medianMs < t.minMedianMs || medianMs < t.minRatio * baselineMs) return [];
  return [
    {
      kind: "workflow_slow",
      ...subject(entry),
      severity: round4(1 - baselineMs / medianMs),
      impact: Math.round((health.runs * (medianMs - baselineMs)) / 1000),
      route: "show_turns",
      metrics: {
        medianMs,
        p95Ms: health.p95Ms,
        baselineMs,
        ratio: round4(medianMs / baselineMs),
        slowestStep: health.slowestStep?.toolId ?? null,
        slowestStepShare: health.slowestStep ? round4(health.slowestStep.share) : null,
        slowestStepMedianMs: health.slowestStep?.medianMs ?? null,
      },
      evidence: evidence(health.slowExamples, health.runs, health),
    },
  ];
}

function fixedChain(
  entry: WorkflowWithHealth,
  t: WorkflowThresholds["fixedChain"],
): WorkflowSignal[] {
  const { workflow, health } = entry;
  if (health.runs < t.minRuns || workflow.coreTools.length < t.minCoreSize) return [];
  if (workflow.orderStability < t.minOrderStability) return [];
  return [
    {
      kind: "workflow_fixed_chain",
      ...subject(entry),
      severity: round4(wilsonLow(workflow.orderStableRuns, workflow.orderRuns)),
      impact: health.runs * (workflow.coreTools.length - 1),
      route: "workflow_skill",
      metrics: {
        typicalOrder: workflow.typicalOrder,
        orderStability: round4(workflow.orderStability),
        orderRuns: workflow.orderRuns,
        orderStableRuns: workflow.orderStableRuns,
        coreSize: workflow.coreTools.length,
        entryTool: workflow.entryTool,
      },
      evidence: evidence(health.recentExamples, workflow.orderStableRuns, health),
    },
  ];
}

/** Every workflow signal over a run's workflows, in input order, kinds in catalog order. */
export function detectWorkflowSignals(
  entries: readonly WorkflowWithHealth[],
  thresholds: WorkflowThresholds = WORKFLOW_THRESHOLDS,
): WorkflowSignal[] {
  const medians = entries.flatMap((entry) =>
    entry.health.medianMs === null ? [] : [entry.health.medianMs],
  );
  const baselineMs = median(medians);
  return entries.flatMap((entry) => [
    ...failing(entry, thresholds.failing),
    ...slow(entry, baselineMs, thresholds.slow),
    ...fixedChain(entry, thresholds.fixedChain),
  ]);
}
