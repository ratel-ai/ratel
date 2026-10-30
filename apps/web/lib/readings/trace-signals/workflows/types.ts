import type { StepDraft, TargetType } from "@/lib/ledger/types";
import type { SelfCorrectionKind } from "@/lib/readings/trace-signals/self-corrections/detect";
import type {
  MetricValue,
  SignalEvidenceRef,
  SignalLane,
  SignalTurn,
} from "@/lib/readings/trace-signals/signals/types";
import type { SignalFixRoute, TurnSourceMix } from "@/lib/readings/trace-signals/view";

/**
 * Shared shapes of workflow mining (Phase W1): a workflow is a recurring group
 * of tools the agent runs to serve one higher-level request. Everything here is
 * plain data, so a mining result can go into a run summary as JSON.
 */

/** Tunables of {@link mineWorkflows}. Every field has a default in {@link DEFAULT_WORKFLOW_CONFIG}. */
export interface WorkflowConfig {
  /** Fewest turns that must contain an itemset for it to be a candidate. */
  minSupport: number;
  /** ...and the fewest as a share of multi-tool turns; the larger floor wins. */
  minShare: number;
  /** Itemset sizes mined, inclusive. */
  minSize: number;
  maxSize: number;
  /** Frequent itemsets kept at most (size 2 and up), so a dense project stays bounded. */
  maxCandidates: number;
  /** A tool in at least this share of multi-tool turns is ubiquitous (a helper). */
  ubiquitousShare: number;
  /**
   * A ubiquitous tool joins an itemset only when the rest of the itemset
   * predicts it beyond its base rate p: P(tool | rest) >= p + (1 - p) * headroom.
   */
  ubiquitousHeadroom: number;
  /** A turn that does not contain a core joins it at this weighted Jaccard or more. */
  assignJaccard: number;
  /** Workflows returned at most. */
  maxWorkflows: number;
  /** Candidates re-scored by full coverage (contained plus near turns) each greedy round. */
  rerankTop: number;
  /** A superset whose support is at least this share of a subset's replaces the subset. */
  closedRatio: number;
  /** A tool in at least this share of a workflow's turns is core. */
  coreShare: number;
  /** ...and in at least this share (below core) is optional. */
  optionalShare: number;
}

export const DEFAULT_WORKFLOW_CONFIG: Readonly<WorkflowConfig> = Object.freeze({
  minSupport: 10,
  minShare: 0.01,
  minSize: 2,
  maxSize: 8,
  maxCandidates: 5_000,
  ubiquitousShare: 0.5,
  ubiquitousHeadroom: 0.5,
  assignJaccard: 0.6,
  maxWorkflows: 12,
  rerankTop: 16,
  closedRatio: 0.85,
  coreShare: 0.7,
  optionalShare: 0.2,
});

/** The step fields mining and health read; a full `StepDraft` satisfies it. */
export type WorkflowStep = Pick<
  StepDraft,
  "kind" | "targetType" | "targetId" | "outcome" | "tookMs" | "traceEventId"
> & {
  /**
   * The agent's wait after this call before its next call in the run (the
   * hand-off: a model turn, a search, a decision), when both ends were timed
   * and it was under `MAX_HANDOFF_MS`. Set on the signal run's compact copies
   * (`compactTurn`); absent elsewhere.
   */
  handoffMs?: number | null;
};

/** One self-correction as a task reads it (`self-corrections/detect.ts`): its kind and the call before it. */
export interface TurnCorrection {
  kind: SelfCorrectionKind;
  /** The call before it, as a node id (a skill as `skill:<id>`); null when there is none. */
  tool: string | null;
  recovered: boolean | null;
}

/** A tool call: an invoke step whose target is a tool. */
export type WorkflowToolCall = WorkflowStep & { targetType: TargetType; targetId: string };

/**
 * A closed turn as mining and health read it. A `SignalTurn` satisfies it; the
 * signal run keeps compact copies of this shape (tool calls only).
 */
export interface WorkflowTurn
  extends Pick<SignalTurn, "id" | "startedAt" | "endedAt" | "turnSource"> {
  steps: readonly WorkflowStep[];
  /** An SDK run's linked OpenTelemetry model calls (`linked-runs.ts`); absent otherwise. */
  model?: WorkflowRunModel;
  /** The run's self-corrections, in step order; absent when it had none or nobody read them. */
  corrections?: readonly TurnCorrection[];
}

/** One run's model calls, as workflow health reads them. */
export interface WorkflowRunModel {
  calls: number;
  /** Null when the model has no known price. */
  costUsd: number | null;
  /** Summed model-call time, and the run's wall time with its model calls. */
  modelMs: number;
  runMs: number;
}

/**
 * What a workflow's runs spent in the model, over the runs linked to model
 * calls (SDK runs whose agent also sends OpenTelemetry).
 */
export interface WorkflowModelHealth {
  /** Runs with linked model calls. */
  runs: number;
  /** Over the runs whose model has a price; null when none has. */
  medianCostUsd: number | null;
  medianModelCalls: number;
  /** Model time over run time, in [0, 1]. */
  modelShare: number;
}

/** One turn as mining reads it: its distinct tools and the order each was first called. */
export interface TurnUnit {
  turnId: string;
  /** Distinct tool ids, sorted. */
  tools: readonly string[];
  /** Distinct tool ids in first-call order. */
  path: readonly string[];
}

/** A tool group and its identity, the part {@link assignTurn} and {@link matchPrevious} need. */
export interface WorkflowCore {
  /** Fingerprint of the sorted core tools (see `fingerprint.ts`). */
  id: string;
  /** Sorted. */
  coreTools: readonly string[];
}

export interface Workflow extends WorkflowCore {
  /** Non-core tools in at least `optionalShare` of member turns, sorted. */
  optionalTools: readonly string[];
  /** Ubiquitous tools outside the core seen in at least `optionalShare` of member turns, sorted. */
  helperTools: readonly string[];
  /** The tool member turns most often call first. */
  entryTool: string;
  /** Core tools by majority pairwise precedence across member turns. */
  typicalOrder: readonly string[];
  /** `orderStableRuns / orderRuns`; 0 when no member ran every core tool. */
  orderStability: number;
  /** Member turns that ran every core tool. */
  orderRuns: number;
  /** ...of those, turns whose first calls of the core tools follow `typicalOrder`. */
  orderStableRuns: number;
  memberTurnIds: readonly string[];
  runs: number;
  /** `runs` over every turn that called any tool. */
  share: number;
  /** The mined itemset the workflow grew from, sorted. */
  seedTools: readonly string[];
  /** Multi-tool turns containing the seed when it was picked. */
  seedSupport: number;
}

export interface WorkflowMiningResult {
  /** Most runs first. */
  workflows: readonly Workflow[];
  /** Turns that called at least one tool. */
  turnsWithTools: number;
  /** Turns that called two or more distinct tools: the mining population. */
  multiToolTurns: number;
  /** Turns that called exactly one distinct tool: never a workflow. */
  singleStepTurns: number;
  /** Multi-tool turns placed in a workflow. */
  assignedTurns: number;
  /** The support floor applied: max(minSupport, minShare x multiToolTurns). */
  supportFloor: number;
  /** IDF weight per tool seen in a multi-tool turn: ln(1 + multiToolTurns / df). */
  idf: Readonly<Record<string, number>>;
  /** Tools at or above `ubiquitousShare`, sorted. */
  ubiquitousTools: readonly string[];
  /** Frequent itemsets (size 2 and up) the miner kept. */
  candidateCount: number;
  /** True when `maxCandidates` cut the lattice short. */
  truncated: boolean;
}

/** One example turn and the step that best shows the problem (null when none does). */
export interface WorkflowExample {
  turnId: string;
  traceEventId: string | null;
}

export interface WorkflowStepShare {
  toolId: string;
  /** Terminal failures at this tool, or its summed `tookMs`. */
  count: number;
  /** Of all terminal failures, or of all summed `tookMs`. */
  share: number;
}

export interface WorkflowSlowStep extends WorkflowStepShare {
  medianMs: number | null;
}

export interface WorkflowHealth {
  workflowId: string;
  /** Member turns found in the map given. */
  runs: number;
  /** Runs whose last tool call did not end in `error`. */
  completedRuns: number;
  completion: number;
  /** Runs whose last tool call ended in `error`. */
  failedRuns: number;
  failingStep: WorkflowStepShare | null;
  medianMs: number | null;
  p95Ms: number | null;
  slowestStep: WorkflowSlowStep | null;
  /** Runs that called the same tool twice or more in a row. */
  retryRuns: number;
  /** Runs with any tool call ending in `error`. */
  errorRuns: number;
  meanToolCalls: number;
  turnSourceMix: TurnSourceMix;
  /** Up to `evidenceTurns` failed runs, newest first, with the failing step. */
  failedExamples: readonly WorkflowExample[];
  /** Up to `evidenceTurns` of the slowest runs, slowest first. */
  slowExamples: readonly WorkflowExample[];
  /** Up to `evidenceTurns` runs, newest first. */
  recentExamples: readonly WorkflowExample[];
  /** Absent unless some run was linked to model calls. */
  model?: WorkflowModelHealth;
}

export type WorkflowSignalKind = "workflow_failing" | "workflow_slow" | "workflow_fixed_chain";

/**
 * A workflow finding. Mirrors `DetectedSignal` field for field, except that
 * `kind` and `subjectKind` are the workflow kinds the signal catalog does not
 * declare yet, so wiring is a mapping, not a rewrite.
 */
export interface WorkflowSignal {
  kind: WorkflowSignalKind;
  subjectKind: "workflow";
  /** The workflow id (its fingerprint, or the previous id `matchPrevious` mapped it to). */
  subjectKey: string;
  /** Core tools in typical order. */
  subjectIds: readonly string[];
  entryKind: "tool";
  lane: SignalLane;
  /** In [0, 1]: the Wilson bound the detector fired on. */
  severity: number;
  impact: number;
  n: number;
  route: SignalFixRoute;
  metrics: Readonly<Record<string, MetricValue>>;
  evidence: SignalEvidenceRef;
}
