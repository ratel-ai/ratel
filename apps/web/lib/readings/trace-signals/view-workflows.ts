import type { SignalKind } from "@/lib/readings/trace-signals/view";

/**
 * The Workflows section's part of the view model (`HealthPageModel.workflows`),
 * built by `workflows-view.ts`. Kept beside `view.ts` and re-exported from it,
 * so the page still has one contract. A workflow is a recurring group of tools
 * the agent runs for one request.
 */

/** A tool a workflow runs, with its display name. */
export interface WorkflowToolView {
  id: string;
  label: string;
}

/** The one open problem a workflow row leads with. */
export interface WorkflowProblemView {
  signalId: string;
  kind: SignalKind;
  /** The signal's claim, e.g. "Runs of Close out a release fail 31% of the time, most often at update_status." */
  claim: string;
}

/** A step a workflow fails at or spends its time in. */
export interface WorkflowStepView {
  tool: WorkflowToolView;
  /** Of failed runs, those that failed here; of run time, the part spent here. */
  share: number;
}

/** One example run of a workflow, as Traces opens it. */
export interface WorkflowExampleView {
  turnId: string;
  /** The call to ring on the turn page; null opens the turn at the top. */
  focusEventId: string | null;
  why: "failed" | "slow" | "recent";
}

/**
 * What a workflow's runs spend in the model, when its SDK runs are linked to
 * OpenTelemetry model calls (same session id on both).
 */
export interface WorkflowModelView {
  /** Median dollars a run costs; null when the model has no known price. */
  costUsd: number | null;
  /** Median model calls a run makes. */
  modelCalls: number;
  /** Share of run time spent in the model, in [0, 1]. */
  modelShare: number;
}

/** One workflow as a row: name, steps in order, how often and how well it runs. */
export interface WorkflowRowView {
  /** Stable across runs; the subject key of the workflow's signals. */
  id: string;
  name: string;
  /** A model-written one-line description, when one exists. */
  description: string | null;
  /** The row's icon key (`workflows/icons.ts`): the model's pick, or the default. */
  icon: string;
  /** The typical order, as compact chips. */
  steps: readonly WorkflowToolView[];
  /** Tool ids the map focuses on: the typical order. */
  focusTools: readonly string[];
  runs: number;
  /** Of all multi-tool runs, in [0, 1]. */
  share: number;
  /** Runs that ended without a failed call, in [0, 1]. */
  completion: number;
  medianMs: number | null;
  /** The worst open workflow problem (failing before slow), or null. */
  problem: WorkflowProblemView | null;
  /** "Build this" when its steps always run in the same order; null otherwise. */
  build: string | null;
  failingStep: WorkflowStepView | null;
  slowestStep: WorkflowStepView | null;
  examples: readonly WorkflowExampleView[];
  /**
   * Runs whose user asked for this workflow (as the choice model read the ask)
   * but that never ran all its steps: they stopped early or went elsewhere.
   * Null when no asks were read or none stopped short.
   */
  stoppedShort: { runs: number; withErrors: number } | null;
  /** Cost, model calls and model time per run; absent unless runs were linked to model calls. */
  model?: WorkflowModelView;
}

/** Requests no workflow or tool handles: likely a missing tool. */
export interface UnservedAskView {
  /** The first request of the group, as it arrived. */
  title: string;
  /** Other requests of the group, as they arrived. */
  others: readonly string[];
  runs: number;
  /**
   * Why the group counts: `no_tool` when the tool check found no tool that
   * does it, `unresolved` when only the runs that failed or called no tool
   * count. Null on insights stored before the reason existed.
   */
  reason?: "no_tool" | "unresolved" | null;
  /** Runs to open in Traces. */
  turnIds: readonly string[];
}

export interface WorkflowsView {
  /** Most runs first. */
  items: readonly WorkflowRowView[];
  /** Runs that called two or more tools: what workflows are found in. */
  multiToolTurns: number;
  /** Of those, runs placed in a workflow. */
  assignedTurns: number;
  /** Runs with fewer tools than this never form a workflow. */
  minTools: number;
  /** A workflow needs at least this many runs. */
  minRuns: number;
  /** Chain signals (`sequence_chain`) whose pair lies inside a workflow, by signal id, to that workflow's id. */
  chainOwners: Readonly<Record<string, string>>;
  /** Asks no workflow handles; empty when none were read or none went unresolved. */
  unserved: readonly UnservedAskView[];
  /** Why workflows are hidden: no tool call was recorded, or runs from different users are mixed together. */
  blocked: "no_tool_calls" | "mixed_runs" | null;
  /** When only runs with exact boundaries were read: the first one's start (ISO), else null. */
  readingSince: string | null;
  /** Guessed runs left out of the reading. */
  excludedRuns: number;
  /**
   * Where the requests behind names and placements came from: the users' own
   * messages, the agent's searches standing in for them, both, or none read.
   */
  asksFrom: "user" | "search" | "mixed" | null;
}
