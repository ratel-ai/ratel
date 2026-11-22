import type { TurnSourceMix } from "@/lib/readings/trace-signals/view";
import type { TaskReading } from "@/lib/readings/trace-signals/workflows/reading";
import type { RunBasis } from "@/lib/readings/trace-signals/workflows/run-basis";
import type {
  Workflow,
  WorkflowExample,
  WorkflowHealth,
  WorkflowMiningResult,
  WorkflowModelHealth,
  WorkflowSlowStep,
  WorkflowStepShare,
} from "@/lib/readings/trace-signals/workflows/types";

/**
 * The workflows a signal run stores in `trace_signal_runs.summary.workflows`
 * (additive, like `flow.journey`: a summary without it still parses). Plain
 * JSON with rounded shares and at most five example runs per list, so twelve
 * workflows stay well under 50 KB. Member turn ids are never stored: the
 * examples are the only turns a workflow points at, and each run's task is
 * written to `trace_turns.workflow_id` instead. Each workflow (a task in the
 * product) also carries its step-by-step reading (`workflows/reading.ts`),
 * absent on runs stored before it.
 */

export const STORED_WORKFLOWS_VERSION = 1;

export interface StoredWorkflowHealth {
  completion: number;
  completedRuns: number;
  failedRuns: number;
  failingStep: WorkflowStepShare | null;
  medianMs: number | null;
  p95Ms: number | null;
  slowestStep: WorkflowSlowStep | null;
  retryRuns: number;
  errorRuns: number;
  meanToolCalls: number;
  turnSourceMix: TurnSourceMix;
  /** Cost, model calls and model time of the runs linked to OpenTelemetry model calls; absent without any. */
  model?: WorkflowModelHealth;
}

export interface StoredWorkflowExamples {
  /** Failed runs, newest first, each with the step it failed at. */
  failed: WorkflowExample[];
  /** The slowest runs, slowest first. */
  slow: WorkflowExample[];
  /** The newest runs. */
  recent: WorkflowExample[];
}

export interface StoredWorkflow {
  /** Stable across runs: the previous run's id when the core only drifted. */
  id: string;
  /** Fingerprint of this run's core tools; equals `id` unless the id was carried over. */
  fingerprint: string;
  coreTools: string[];
  optionalTools: string[];
  helperTools: string[];
  entryTool: string;
  typicalOrder: string[];
  orderStability: number;
  runs: number;
  share: number;
  health: StoredWorkflowHealth;
  examples: StoredWorkflowExamples;
  /** The task read step by step from its runs; absent on runs stored before it. */
  reading?: TaskReading;
}

export interface StoredWorkflows {
  version: 1;
  /** Collected turns that called at least one tool. */
  turnsWithTools: number;
  /** ...two or more distinct tools: the mining population. */
  multiToolTurns: number;
  /** ...exactly one distinct tool: never a workflow. */
  singleStepTurns: number;
  /** Runs placed in a workflow (`workflows/place.ts`): the runs the items count. */
  assignedTurns: number;
  /** True when the turn cap or the candidate cap cut mining short. */
  truncated: boolean;
  /** Most runs first. */
  items: StoredWorkflow[];
  /** Which runs were mined, and why workflows are hidden when they are (`run-basis.ts`). Absent on older runs. */
  basis?: RunBasis;
  /**
   * The project's helper tools: in at least `ubiquitousShare` of the
   * multi-tool turns mined (`WorkflowMiningResult.ubiquitousTools`), sorted.
   * Other readers (an intent's tool pattern) set them aside with this set
   * rather than deriving their own. Absent on runs stored before it: read as
   * none.
   */
  ubiquitousTools?: string[];
}

/** The helper tools a stored run names; none on runs stored before they were kept. */
export function storedHelperTools(
  workflows: Partial<StoredWorkflows> | null | undefined,
): string[] {
  const tools = workflows?.ubiquitousTools;
  return Array.isArray(tools)
    ? tools.filter((tool): tool is string => typeof tool === "string")
    : [];
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

function stepShare<T extends WorkflowStepShare>(step: T | null): T | null {
  return step ? { ...step, share: round4(step.share) } : null;
}

const examples = (list: readonly WorkflowExample[]): WorkflowExample[] =>
  list.map((e) => ({ turnId: e.turnId, traceEventId: e.traceEventId }));

function storedHealth(health: WorkflowHealth): StoredWorkflowHealth {
  return {
    completion: round4(health.completion),
    completedRuns: health.completedRuns,
    failedRuns: health.failedRuns,
    failingStep: stepShare(health.failingStep),
    medianMs: health.medianMs,
    p95Ms: health.p95Ms,
    slowestStep: stepShare(health.slowestStep),
    retryRuns: health.retryRuns,
    errorRuns: health.errorRuns,
    meanToolCalls: round4(health.meanToolCalls),
    turnSourceMix: { ...health.turnSourceMix },
    ...(health.model ? { model: storedModel(health.model) } : {}),
  };
}

function storedModel(model: WorkflowModelHealth): WorkflowModelHealth {
  return {
    runs: model.runs,
    medianCostUsd:
      model.medianCostUsd === null ? null : Math.round(model.medianCostUsd * 1_000_000) / 1_000_000,
    medianModelCalls: model.medianModelCalls,
    modelShare: round4(model.modelShare),
  };
}

/** The reading with its shares rounded like the rest of the item. */
function storedReading(reading: TaskReading): TaskReading {
  return {
    ...reading,
    steps: reading.steps.map((step) => ({
      ...step,
      next: step.next.map((next) => ({ ...next, share: round4(next.share) })),
    })),
  };
}

/** One workflow as stored; `workflow.id` is the (possibly carried) id, `fingerprint` this run's own. */
export function storedWorkflow(
  workflow: Workflow,
  fingerprint: string,
  health: WorkflowHealth,
  reading?: TaskReading,
): StoredWorkflow {
  return {
    id: workflow.id,
    fingerprint,
    coreTools: [...workflow.coreTools],
    optionalTools: [...workflow.optionalTools],
    helperTools: [...workflow.helperTools],
    entryTool: workflow.entryTool,
    typicalOrder: [...workflow.typicalOrder],
    orderStability: round4(workflow.orderStability),
    runs: workflow.runs,
    share: round4(workflow.share),
    health: storedHealth(health),
    examples: {
      failed: examples(health.failedExamples),
      slow: examples(health.slowExamples),
      recent: examples(health.recentExamples),
    },
    ...(reading ? { reading: storedReading(reading) } : {}),
  };
}

export function storedWorkflows(
  mining: WorkflowMiningResult,
  items: StoredWorkflow[],
  cappedTurns: boolean,
  basis?: RunBasis,
): StoredWorkflows {
  return {
    version: STORED_WORKFLOWS_VERSION,
    turnsWithTools: mining.turnsWithTools,
    multiToolTurns: mining.multiToolTurns,
    singleStepTurns: mining.singleStepTurns,
    assignedTurns: mining.assignedTurns,
    truncated: cappedTurns || mining.truncated,
    items,
    ...(basis ? { basis } : {}),
    ubiquitousTools: [...mining.ubiquitousTools],
  };
}
