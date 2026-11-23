import type { WindowDays } from "@/lib/readings/trace-signals/view";

/**
 * What Agent health can still say about runs no reading can read: an import
 * whose runs carry no tool call the page recognises (`imported_no_tools`).
 * The runs are stored as spans all the same, so the page reads them
 * directly: how many ran, how many finished without a failed span, model
 * round trips, run time and tokens, the steps the runs are made of and the
 * models they call. No turn, intent or tool pick is read here.
 *
 * A step is named generically. It is a likely tool when at least half of its
 * calls hold no other span: a wrapper (a turn, a plan) holds the steps inside it.
 */

/** Per span name, under a run's root, model calls left out. */
export interface StepFact {
  name: string;
  calls: number;
  failed: number;
  /** Calls with no child span. */
  leafCalls: number;
  p95Ms: number | null;
}

export interface ModelFact {
  model: string;
  calls: number;
  tokens: number | null;
}

/** The window's spans, as `loadPartialFacts` reads them. */
export interface PartialFacts {
  /** Root spans that started in the window. */
  runs: number;
  /** Runs with no failed span, the root included. */
  completedRuns: number;
  /** Spans under the roots, model calls included. */
  calls: number;
  failedCalls: number;
  modelCalls: number;
  /** Input plus output tokens of the model calls; null when none carry a count. */
  tokens: number | null;
  p95RunMs: number | null;
  steps: readonly StepFact[];
  models: readonly ModelFact[];
}

export interface PartialStep {
  name: string;
  calls: number;
  failed: number;
  p95Ms: number | null;
  likelyTool: boolean;
}

export interface PartialReading {
  windowDays: WindowDays;
  runs: number;
  /** Null with no runs. */
  completedShare: number | null;
  calls: number;
  failedCalls: number;
  roundTripsPerRun: number | null;
  p95RunMs: number | null;
  tokensPerRun: number | null;
  steps: PartialStep[];
  models: ModelFact[];
}

export function partialReading(facts: PartialFacts, windowDays: WindowDays): PartialReading {
  const perRun = (n: number | null) => (n === null || facts.runs === 0 ? null : n / facts.runs);
  return {
    windowDays,
    runs: facts.runs,
    completedShare: perRun(facts.completedRuns),
    calls: facts.calls,
    failedCalls: facts.failedCalls,
    roundTripsPerRun: perRun(facts.modelCalls),
    p95RunMs: facts.p95RunMs,
    tokensPerRun: perRun(facts.tokens),
    steps: facts.steps
      .map((s) => ({
        name: s.name,
        calls: s.calls,
        failed: s.failed,
        p95Ms: s.p95Ms,
        likelyTool: isLikelyTool(s),
      }))
      .sort(mostCalledFirst((s) => s.name)),
    models: [...facts.models].sort(mostCalledFirst((m) => m.model)),
  };
}

function isLikelyTool(step: StepFact): boolean {
  return step.calls > 0 && step.leafCalls * 2 >= step.calls;
}

function mostCalledFirst<T extends { calls: number }>(
  key: (item: T) => string,
): (a: T, b: T) => number {
  return (a, b) => b.calls - a.calls || key(a).localeCompare(key(b));
}
