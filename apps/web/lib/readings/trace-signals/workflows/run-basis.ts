import type { TurnEndedBy, TurnSource } from "@/lib/ledger/types";
import { envNumber } from "@/lib/platform/env-number";

/**
 * Which runs workflows are mined from, decided from how the runs were cut.
 *
 * A run has exact boundaries when the customer said where it starts and ends:
 * an SDK `turn_id` (`declared`) or one OpenTelemetry trace (`otlp`). Without a
 * turn id the SDK lane guesses (`inferred`): a quiet gap ends a run, or a cap
 * (steps or minutes) cuts one that never goes quiet. A server answering many
 * users at once shares one session and never goes quiet, so nearly every
 * guessed run ends at a cap and holds several users' calls mixed together.
 * Workflows mined from those are noise, so they are hidden until turn ids
 * arrive.
 *
 * Exact runs win: once there are enough of them, the guessed runs are left out
 * and the reading starts where turn ids started, which is how a project that
 * fixes its setup is read from its fixed runs alone.
 */

/** Exact multi-tool runs that are enough to mine from without the guessed ones. */
export const MIN_EXACT_RUNS = Math.floor(envNumber("TRACE_SIGNALS_MIN_EXACT_RUNS", 30));
/** Guessed runs needed before their endings say anything about mixing. */
export const MIN_INFERRED_FOR_MIX = Math.floor(envNumber("TRACE_SIGNALS_MIN_INFERRED_FOR_MIX", 20));
/** Share of guessed runs cut at a cap from which runs read as mixed together. */
export const MIXED_CAP_SHARE = envNumber("TRACE_SIGNALS_MIXED_CAP_SHARE", 0.25);

/** all: every run; exact: only runs with exact boundaries; none: workflows hidden. */
export type WorkflowBasis = "all" | "exact" | "none";

/** Why workflows are hidden, or null when they are not. */
export type WorkflowBlock = "no_tool_calls" | "mixed_runs" | null;

/** What the run counted, per run, before mining. */
export interface RunBasisCounts {
  /** Every closed run in the window. */
  runs: number;
  /** Runs that called at least one tool. */
  runsWithTools: number;
  /** Guessed runs, and those cut at a cap. */
  inferred: number;
  inferredCapped: number;
  /** Multi-tool runs with exact boundaries, and the earliest one's start. */
  exactMultiTool: number;
  exactSince: number | null;
  /** Multi-tool guessed runs. */
  inferredMultiTool: number;
}

export interface RunBasis {
  basis: WorkflowBasis;
  blocked: WorkflowBlock;
  /** Guessed runs left out because exact ones were enough, or because they were mixed. */
  excludedRuns: number;
  /** When `exact` left guessed runs out: the first exact run's start (ISO), else null. */
  since: string | null;
  /** Guessed runs read as several users mixed together. */
  mixed: boolean;
}

export function emptyRunBasisCounts(): RunBasisCounts {
  return {
    runs: 0,
    runsWithTools: 0,
    inferred: 0,
    inferredCapped: 0,
    exactMultiTool: 0,
    exactSince: null,
    inferredMultiTool: 0,
  };
}

/** Exact boundaries: a declared turn id or one OpenTelemetry trace. */
export function isExactRun(turnSource: TurnSource): boolean {
  return turnSource !== "inferred";
}

/** Adds one closed run to the counts. `distinctTools` counts the tools it called. */
export function countRun(
  counts: RunBasisCounts,
  run: { turnSource: TurnSource; endedBy?: TurnEndedBy | null; startedAt: Date },
  distinctTools: number,
): void {
  counts.runs += 1;
  if (distinctTools > 0) counts.runsWithTools += 1;
  const exact = isExactRun(run.turnSource);
  if (!exact) {
    counts.inferred += 1;
    if (run.endedBy === "cap") counts.inferredCapped += 1;
  }
  if (distinctTools < 2) return;
  if (!exact) {
    counts.inferredMultiTool += 1;
    return;
  }
  counts.exactMultiTool += 1;
  const at = run.startedAt.getTime();
  counts.exactSince = counts.exactSince === null ? at : Math.min(counts.exactSince, at);
}

/** Guessed runs read as several users mixed together: most of them never went quiet. */
export function runsLookMixed(
  counts: Pick<RunBasisCounts, "inferred" | "inferredCapped">,
): boolean {
  return (
    counts.inferred >= MIN_INFERRED_FOR_MIX &&
    counts.inferredCapped / counts.inferred >= MIXED_CAP_SHARE
  );
}

export function chooseRunBasis(counts: RunBasisCounts): RunBasis {
  const mixed = runsLookMixed(counts);
  if (counts.runs > 0 && counts.runsWithTools === 0) {
    return { basis: "none", blocked: "no_tool_calls", excludedRuns: 0, since: null, mixed };
  }
  const since = counts.exactSince === null ? null : new Date(counts.exactSince).toISOString();
  const leaveOut =
    counts.inferredMultiTool > 0 &&
    (counts.exactMultiTool >= MIN_EXACT_RUNS || (mixed && counts.exactMultiTool > 0));
  if (leaveOut)
    return { basis: "exact", blocked: null, excludedRuns: counts.inferredMultiTool, since, mixed };
  if (mixed && counts.inferredMultiTool > 0) {
    return {
      basis: "none",
      blocked: "mixed_runs",
      excludedRuns: counts.inferredMultiTool,
      since: null,
      mixed,
    };
  }
  return { basis: "all", blocked: null, excludedRuns: 0, since: null, mixed };
}

/** Whether a run is mined under a basis. */
export function minesRun(basis: WorkflowBasis, turnSource: TurnSource): boolean {
  if (basis === "none") return false;
  return basis === "all" || isExactRun(turnSource);
}
