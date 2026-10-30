import { RUN_BOUND_KINDS } from "@/lib/readings/trace-signals/run-bound";
import type { StoredSelfCorrections } from "@/lib/readings/trace-signals/self-corrections/run";
import type { StoredSetup } from "@/lib/readings/trace-signals/setup-facts";
import type { SignalKind, TurnSourceMix } from "@/lib/readings/trace-signals/view";
import { isExactRun } from "@/lib/readings/trace-signals/workflows/run-basis";

export { RUN_BOUND_KINDS };

import {
  accumulateTurn,
  createProjectStats,
  type ProjectStats,
} from "@/lib/readings/trace-signals/signals/accumulators";
import {
  DEFAULT_FLOORS,
  type Floors,
  PAIR_TOOL_MIN_TURNS,
} from "@/lib/readings/trace-signals/signals/catalog";
import { detectDemand } from "@/lib/readings/trace-signals/signals/detect-demand";
import { detectHealth } from "@/lib/readings/trace-signals/signals/detect-health";
import { detectOtel } from "@/lib/readings/trace-signals/signals/detect-otel";
import { detectRetrieval } from "@/lib/readings/trace-signals/signals/detect-retrieval";
import { detectSequence } from "@/lib/readings/trace-signals/signals/detect-sequence";
import { detectSiblings } from "@/lib/readings/trace-signals/signals/detect-siblings";
import { buildFlow, type StoredFlow } from "@/lib/readings/trace-signals/signals/flow-model";
import {
  countJourneyPath,
  countJourneyPositions,
  createJourneyStats,
  finishJourney,
} from "@/lib/readings/trace-signals/signals/journey";
import {
  accumulateOtelTurn,
  createOtelStats,
} from "@/lib/readings/trace-signals/signals/otel-accumulators";
import { otelTurnExtras } from "@/lib/readings/trace-signals/signals/otel-day";
import {
  accumulatePairs,
  createPairStats,
  eligibleTools,
  type PairStats,
} from "@/lib/readings/trace-signals/signals/pairs";
import {
  countPrerequisites,
  createPrerequisiteStats,
  finishPrerequisites,
} from "@/lib/readings/trace-signals/signals/prerequisites";
import { DailyBuckets, type DayBucket } from "@/lib/readings/trace-signals/signals/project-metrics";
import { usesOtelShapes } from "@/lib/readings/trace-signals/signals/turn-facts";
import type {
  AnalysisContext,
  DetectedSignal,
  SignalTurn,
} from "@/lib/readings/trace-signals/signals/types";
import { createWorkflowCollector } from "@/lib/readings/trace-signals/signals/workflow-run";
import type { StoredWorkflows } from "@/lib/readings/trace-signals/signals/workflow-stored";

/**
 * One signal run over a stream of closed turns, independent of where the
 * turns come from: the compute job pages them out of the ledger, the replay
 * CLI hands over `replayTurns` output. Two passes, because pairs are only
 * counted among tools pass one found busy enough:
 *
 *   const run = createAnalysis(context);
 *   for (const t of turns) run.feed(t);          // pass one, every scanned turn
 *   if (run.secondPass())
 *     for (const t of windowTurns) run.feedPairs(t); // pass two, window only
 *   const result = run.finish();
 *
 * `feed` takes the whole scan (the window plus the extra days the health band
 * compares against); only turns ending inside `[windowStart, windowEnd)` reach
 * the detectors, every turn reaches the daily buckets. `feedPairs` ignores
 * turns outside the window, so the job may page the same range twice.
 *
 * Pass two also records each turn's journey (`journey.ts`), which needs pass
 * one's per-position counts to know which tools to keep by name. So it runs
 * whenever there is a journey to record, even with too few busy tools for
 * pairs; the pair kinds then stay unmeasured exactly as before.
 *
 * Pass one also counts what each tool needs first across a session
 * (`prerequisites.ts`), which reads turns oldest first, as both callers feed them.
 *
 * Pass one also keeps a compact copy of every window turn that called a tool,
 * and `finish` mines them for workflows (`workflow-run.ts`), carrying ids over
 * from `context.previousWorkflows`. The workflow signals come last, and the
 * workflows go in the summary only when a turn called a tool, so a run without
 * tool calls stores exactly what it did before.
 */

/** What a run stores beside its signals: see `trace_signal_runs.summary`. */
export interface RunSummary {
  version: 1;
  /** First day the daily buckets cover (`YYYY-MM-DD`). */
  coveredFrom: string;
  daily: DayBucket[];
  flow: StoredFlow;
  /** True when the per-query-hash counters hit their cap and low-count hashes
   * were evicted. Absent on runs stored before the cap existed. */
  queriesTruncated?: boolean;
  /** True when the run read a window cut short by an earlier time-budget
   * failure, so the next run climbs back toward the plan's window instead of
   * jumping to it. Set by the compute job; absent means the plan's window. */
  windowShrunk?: boolean;
  /** What the project sends, data point by data point (`setup-facts.ts`). Set by the compute job; absent on older runs. */
  setup?: StoredSetup;
  /** The workflows mined from the window's turns. Absent on runs stored before
   * workflows existed, and on runs without a single tool call. */
  workflows?: StoredWorkflows;
  /**
   * Turn events received but not yet built into turns when the run started
   * (counted up to a cap), set only when enough to change its numbers: the
   * run read while a backlog was still being built, and the page asks for
   * another once it is (`missedBacklog` in `compute-job.ts`).
   */
  unbuiltAtStart?: number;
  /**
   * What the run's self-correction reading read (`self-corrections/run.ts`):
   * its trust, turns read, turns with captured replies and rows written. Set
   * by the compute job; absent on runs stored before it, or when that reading
   * failed.
   */
  selfCorrections?: StoredSelfCorrections;
}

export interface AnalysisResult {
  signals: DetectedSignal[];
  measured: Set<SignalKind>;
  summary: RunSummary;
  /** Closed turns inside the window. */
  turnsScanned: number;
  turnSourceMix: TurnSourceMix;
  /** Tools that took part in pair counting. */
  pairTools: number;
  /** Query hashes evicted to keep the per-query counters under their cap. */
  queriesEvicted: number;
  /** SDK runs in the window, and those linked to OpenTelemetry model calls (`linked-runs.ts`). */
  linking: LinkingCounts;
  /**
   * The task (workflow id) of each in-window run that called a tool, or null
   * (`workflows/place.ts`); the job writes it to `trace_turns.workflow_id`.
   * Runs absent from it belong to no task.
   */
  placement: ReadonlyMap<string, string | null>;
}

export interface LinkingCounts {
  sdkRuns: number;
  linkedRuns: number;
}

export interface AnalysisOptions {
  floors?: Floors;
  pairMinTurns?: number;
  /** Cap on distinct query hashes counted (defaults to `MAX_QUERY_HASHES`). */
  maxQueryHashes?: number;
  /** Start of the scan (at or before `windowStart`): the daily buckets' first day. */
  scanStart?: Date;
  /** How far back a call looks for what ran before it (defaults to `PREREQ_WINDOW_MS`). */
  prereqWindowMs?: number;
  /** Compact turns kept for workflow mining at most (defaults to `MAX_WORKFLOW_TURNS`). */
  maxWorkflowTurns?: number;
}

/** Pass two needs at least this many busy tools to form a pair. */
export const MIN_PAIR_TOOLS = 2;

export interface Analysis {
  feed(turn: SignalTurn): void;
  /** Tools eligible for pairs, known once pass one is done. */
  pairTools(): number;
  /** Whether pass two has anything to count: pairs (two or more busy tools) or a journey. */
  secondPass(): boolean;
  feedPairs(turn: SignalTurn): void;
  finish(): AnalysisResult;
}

export function createAnalysis(context: AnalysisContext, options: AnalysisOptions = {}): Analysis {
  const floors = options.floors ?? DEFAULT_FLOORS;
  const stats: ProjectStats = createProjectStats(options.maxQueryHashes);
  const journey = createJourneyStats();
  const prerequisites = createPrerequisiteStats(options.prereqWindowMs);
  const daily = new DailyBuckets();
  const workflows = createWorkflowCollector(options.maxWorkflowTurns, floors, context.runBasis);
  // Once enough runs carry turn ids, the guessed ones are left out of the whole reading.
  const exactOnly = context.runBasis?.basis === "exact";
  const read = (turn: SignalTurn): boolean => !exactOnly || isExactRun(turn.turnSource);
  // OTel signals read OTLP-lane turns with the facts ingest recorded beside them; none without facts.
  const otelFacts = context.otel ?? null;
  const otel = otelFacts ? createOtelStats() : null;
  const inWindow = (turn: SignalTurn): boolean =>
    turn.endedAt.getTime() >= context.windowStart.getTime() &&
    turn.endedAt.getTime() < context.windowEnd.getTime();
  const linking: LinkingCounts = { sdkRuns: 0, linkedRuns: 0 };
  let pairs: PairStats | null = null;
  // Whether pass two ran at all. When it was skipped (fewer than two busy
  // tools), the pair kinds were not measured: their open signals must not
  // count the run as a miss.
  let pairPassRan = false;

  const pairStats = (): PairStats => {
    pairs ??= createPairStats(eligibleTools(stats, options.pairMinTurns ?? PAIR_TOOL_MIN_TURNS));
    return pairs;
  };

  return {
    feed(turn) {
      if (!read(turn)) return;
      daily.add(turn, floors, usesOtelShapes(turn) ? otelTurnExtras(turn, otelFacts) : undefined);
      if (!inWindow(turn)) return;
      accumulateTurn(stats, turn, floors);
      countJourneyPositions(journey, turn);
      countPrerequisites(prerequisites, turn);
      if (otel && otelFacts) accumulateOtelTurn(otel, turn, otelFacts);
      workflows.collect(turn);
      if (turn.lane === "runtime") linking.sdkRuns += 1;
      if (turn.linked) linking.linkedRuns += 1;
    },
    pairTools() {
      return pairStats().eligible.size;
    },
    secondPass() {
      return (
        pairStats().eligible.size >= MIN_PAIR_TOOLS ||
        journey.positions[0].size > 0 ||
        stats.turnsWithSearch > 0
      );
    },
    feedPairs(turn) {
      if (!read(turn)) return;
      const pairsOn = pairStats().eligible.size >= MIN_PAIR_TOOLS;
      pairPassRan ||= pairsOn;
      if (!inWindow(turn)) return;
      if (pairsOn) accumulatePairs(pairStats(), turn);
      countJourneyPath(journey, turn);
    },
    finish() {
      const finalPairs = pairStats();
      const mined = workflows.finish(context.previousWorkflows ?? []);
      const results = [
        detectRetrieval(stats, floors),
        detectSequence(stats, finalPairs, floors, pairPassRan),
        detectSiblings(stats, finalPairs, context.catalog, floors, pairPassRan),
        detectHealth(stats, context, floors),
        detectDemand(context.clusters, stats.mix, floors),
        detectOtel(otel, context, floors),
        mined,
      ];
      // Runs mixed together (no turn ids on a busy server) make every per-run
      // reading meaningless: drop those kinds, and leave them unmeasured so an
      // open one is not resolved by a reading that could not see it.
      const mixed = mined.stored.basis?.blocked === "mixed_runs";
      const signals = results
        .flatMap((r) => [...r.signals])
        .filter((s) => !mixed || !RUN_BOUND_KINDS.has(s.kind));
      const measured = new Set(
        results.flatMap((r) => [...r.measured]).filter((k) => !mixed || !RUN_BOUND_KINDS.has(k)),
      );
      const catalogTools = context.catalog.filter((e) => e.kind === "tool").length;
      const scanStart = options.scanStart ?? context.windowStart;
      const flow = buildFlow(stats, finalPairs, signals, catalogTools);
      const stored = finishJourney(journey);
      const needs = finishPrerequisites(prerequisites);
      return {
        signals,
        measured,
        summary: {
          version: 1,
          coveredFrom: scanStart.toISOString().slice(0, 10),
          daily: daily.values(),
          // Additive: a summary without `journey` or `prerequisites` still parses and renders.
          flow: {
            ...flow,
            ...(stored ? { journey: stored } : {}),
            ...(needs ? { prerequisites: needs } : {}),
          },
          queriesTruncated: stats.queriesEvicted > 0,
          // Stored when a tool was called, or when the basis says why workflows are hidden.
          ...(mined.stored.turnsWithTools > 0 || mined.stored.basis?.blocked
            ? { workflows: mined.stored }
            : {}),
        },
        turnsScanned: stats.turns,
        turnSourceMix: { ...stats.mix },
        pairTools: finalPairs.eligible.size,
        queriesEvicted: stats.queriesEvicted,
        linking: { ...linking },
        placement: mined.placement,
      };
    },
  };
}

/** Runs both passes over an in-memory list of turns (tests, replay), skipping
 * pass two when it has nothing to count, exactly as the compute job does. */
export function analyzeTurns(
  turns: readonly SignalTurn[],
  context: AnalysisContext,
  options: AnalysisOptions = {},
): AnalysisResult {
  const run = createAnalysis(context, options);
  for (const turn of turns) run.feed(turn);
  if (run.secondPass()) for (const turn of turns) run.feedPairs(turn);
  return run.finish();
}
