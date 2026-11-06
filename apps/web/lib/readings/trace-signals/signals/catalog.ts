import { envNumber } from "@/lib/platform/env-number";
import type {
  SignalFixRoute,
  SignalKind,
  SignalSubjectKind,
  SignalTier,
} from "@/lib/readings/trace-signals/view";
import { SIGNAL_KINDS } from "@/lib/readings/trace-signals/view";
import { WORKFLOW_THRESHOLDS as WF } from "@/lib/readings/trace-signals/workflows/detect";

/**
 * The signal catalog: the single source of truth for every kind the engine can
 * emit and the page can render. Floors are env-overridable
 * (`TRACE_SIGNALS_<KIND>_<FLOOR>`, e.g. `TRACE_SIGNALS_MAGNET_MIN_IMPRESSIONS`)
 * so a deployment can tune a detector without a release; the Phase 0 replay
 * prints which floors a real ledger reaches. Detectors take a {@link Floors}
 * argument defaulting to these, so tests pin their own values.
 *
 * A signal below its floor is never written. At the floor it is, and its
 * severity is the Wilson bound the detector fired on.
 */

/**
 * Whether Managed improvement (Phase 2, decision 3) may apply a route's fix on
 * the customer's behalf. `safe` routes still pass the backtest guard first;
 * `needs_approval` routes always wait for a person.
 */
export type FixSafety = "safe" | "needs_approval";

export const FIX_SAFETY: Readonly<Record<SignalFixRoute, FixSafety>> = {
  rewrite_description: "safe",
  adaptive_ranking: "safe",
  run_extraction: "safe",
  lower_top_k: "needs_approval",
  retire_tool: "needs_approval",
  workflow_skill: "needs_approval",
  disambiguate_pair: "needs_approval",
  show_turns: "needs_approval",
  none: "needs_approval",
};

export interface SignalCatalogEntry {
  kind: SignalKind;
  subjectKind: SignalSubjectKind;
  tier: SignalTier;
  /** The route named when a detector does not pick a more specific one. */
  fixRoute: SignalFixRoute;
  fixSafety: FixSafety;
  /** 1 ships now; 2 is declared so the UI and tests know it, and never emitted. */
  phase: 1 | 2;
  /** Every floor the detector reads, resolved from the env. */
  floors: Readonly<Record<string, number>>;
}

const isShare = (n: number): boolean => n > 0 && n <= 1;

function floor(kind: SignalKind, name: string, fallback: number, share = false): number {
  const env = `TRACE_SIGNALS_${kind.toUpperCase()}_${name.toUpperCase()}`;
  return envNumber(env, fallback, share ? isShare : undefined);
}

/** Every detector's floors, resolved from the env. Exported so tests can
 * resolve them again under their own env. */
export function resolveFloors() {
  return {
    first_try_miss: {
      minN: floor("first_try_miss", "min_n", 10),
      minK: floor("first_try_miss", "min_k", 3),
      minLow: floor("first_try_miss", "min_low", 0.15, true),
    },
    buried_tool: {
      minN: floor("buried_tool", "min_n", 10),
      minK: floor("buried_tool", "min_k", 3),
      minRank: floor("buried_tool", "min_rank", 4),
      minLow: floor("buried_tool", "min_low", 0.3, true),
    },
    magnet: {
      minImpressions: floor("magnet", "min_impressions", 50),
      // Listings at #1 to #3, the slots a magnet takes from the right tool: a
      // count of them, and a lower bound on the share of searches whose top
      // three it took. A tool that only pads the tail of long lists is not a magnet.
      minTop3Impressions: floor("magnet", "min_top3_impressions", 20),
      minTop3Low: floor("magnet", "min_top3_low", 0.05, true),
      maxHigh: floor("magnet", "max_high", 0.03, true),
      maxPicks: floor("magnet", "max_picks", 4),
    },
    dead_tool: {
      minLedgerDays: floor("dead_tool", "min_ledger_days", 14),
      minTurns: floor("dead_tool", "min_turns", 200),
    },
    sequence_chain: {
      minPairs: floor("sequence_chain", "min_pairs", 10),
      minLift: floor("sequence_chain", "min_lift", 3),
      minConditional: floor("sequence_chain", "min_conditional", 0.4, true),
      dependencyShare: floor("sequence_chain", "dependency_share", 0.8, true),
      workflowViaSearch: floor("sequence_chain", "workflow_via_search", 0.5, true),
    },
    sibling_confusion: {
      minCoHitShare: floor("sibling_confusion", "min_co_hit_share", 0.3, true),
      minSwaps: floor("sibling_confusion", "min_swaps", 5),
      minSplit: floor("sibling_confusion", "min_split", 0.2, true),
    },
    error_loop: {
      minErrors: floor("error_loop", "min_errors", 5),
      minLoopTurns: floor("error_loop", "min_loop_turns", 3),
      minLow: floor("error_loop", "min_low", 0.2, true),
    },
    no_follow_through: {
      minN: floor("no_follow_through", "min_n", 10),
      minK: floor("no_follow_through", "min_k", 3),
      withinMs: floor("no_follow_through", "within_ms", 30_000),
      minLow: floor("no_follow_through", "min_low", 0.1, true),
    },
    abandoned_search: {
      minTurns: floor("abandoned_search", "min_turns", 30),
      minLow: floor("abandoned_search", "min_low", 0.1, true),
    },
    padding_share: {
      minSearches: floor("padding_share", "min_searches", 100),
      maxPickRankP95: floor("padding_share", "max_pick_rank_p95", 3),
      minMedianTopK: floor("padding_share", "min_median_top_k", 8),
      minJunkLow: floor("padding_share", "min_junk_low", 0.5, true),
      pickCutoff: floor("padding_share", "pick_cutoff", 5),
    },
    latency_outlier: {
      minN: floor("latency_outlier", "min_n", 20),
      minP95Ms: floor("latency_outlier", "min_p95_ms", 10_000),
      medianMultiple: floor("latency_outlier", "median_multiple", 5),
    },
    unstable_intent: {
      minN: floor("unstable_intent", "min_n", 8),
      minDistinct: floor("unstable_intent", "min_distinct", 3),
      maxTopShare: floor("unstable_intent", "max_top_share", 0.5, true),
    },
    repeat_invoke: {
      minN: floor("repeat_invoke", "min_n", 10),
      minK: floor("repeat_invoke", "min_k", 3),
      minCalls: floor("repeat_invoke", "min_calls", 3),
      minLow: floor("repeat_invoke", "min_low", 0.1, true),
    },
    fragmented_intents: {
      minClusters: floor("fragmented_intents", "min_clusters", 20),
      minLow: floor("fragmented_intents", "min_low", 0.5, true),
    },
    cooccurring_intents: {},
    // The OTel kinds (`detect-otel.ts`) read OTLP-lane turns only.
    tool_switch: {
      // Turns where a failed or empty call of A was followed at once by a good
      // call of B, and their share of the OTel turns that call A.
      minTurns: floor("tool_switch", "min_turns", 10),
      minShare: floor("tool_switch", "min_share", 0.2, true),
    },
    empty_result: {
      minCaptured: floor("empty_result", "min_captured", 20),
      minShare: floor("empty_result", "min_share", 0.4, true),
      minLow: floor("empty_result", "min_low", 0.3, true),
    },
    unknown_tool: {
      minCalls: floor("unknown_tool", "min_calls", 5),
    },
    unused_tool: {
      minModelCalls: floor("unused_tool", "min_model_calls", 50),
      minTurns: floor("unused_tool", "min_turns", 20),
    },
    long_turn: {
      // A long turn makes at least max(minCalls, medianMultiple x median) model calls.
      minCalls: floor("long_turn", "min_calls", 8),
      medianMultiple: floor("long_turn", "median_multiple", 3),
      minTurns: floor("long_turn", "min_turns", 10),
      minShare: floor("long_turn", "min_share", 0.05, true),
      // A tool is named when it shows up in this many long turns and this many
      // times more often there than in turns overall.
      minToolTurns: floor("long_turn", "min_tool_turns", 3),
      minToolRatio: floor("long_turn", "min_tool_ratio", 1.5),
    },
    // Calls refused for permission, plan or budget, over this many turns.
    blocked_action: {
      minCalls: floor("blocked_action", "min_calls", 3),
      minTurns: floor("blocked_action", "min_turns", 2),
    },
    // Turns where a failed call was sent again unchanged, and their share of the turns where it failed.
    identical_retry: {
      minTurns: floor("identical_retry", "min_turns", 3),
      minShare: floor("identical_retry", "min_share", 0.2, true),
    },
    // A tool's share of all OTel turn time, with a long typical call.
    wait_heavy: {
      minCalls: floor("wait_heavy", "min_calls", 10),
      minShare: floor("wait_heavy", "min_share", 0.15, true),
      minMedianMs: floor("wait_heavy", "min_median_ms", 10_000),
    },
    // The heaviest topShare of turns use minTokenShare of input tokens, at minRatio x the median turn.
    token_heavy: {
      minTurns: floor("token_heavy", "min_turns", 30),
      topShare: floor("token_heavy", "top_share", 0.05, true),
      minTokenShare: floor("token_heavy", "min_token_share", 0.4, true),
      minRatio: floor("token_heavy", "min_ratio", 5),
    },
    // System-started turns that fail, against person-started ones.
    system_turn_failing: {
      minTurns: floor("system_turn_failing", "min_turns", 20),
      minLow: floor("system_turn_failing", "min_low", 0.1, true),
      minRatio: floor("system_turn_failing", "min_ratio", 2),
    },
    // One agent's tool calls fail far more often than the other agents'.
    agent_failing: {
      minCalls: floor("agent_failing", "min_calls", 30),
      minLow: floor("agent_failing", "min_low", 0.05, true),
      minRatio: floor("agent_failing", "min_ratio", 2),
    },
    // The workflow kinds (`workflows/detect.ts`) read mined workflows, on any lane.
    workflow_failing: {
      minRuns: floor("workflow_failing", "min_runs", WF.failing.minRuns),
      maxCompletion: floor("workflow_failing", "max_completion", WF.failing.maxCompletion, true),
      minFailureLow: floor("workflow_failing", "min_failure_low", WF.failing.minFailureLow, true),
    },
    workflow_slow: {
      minRuns: floor("workflow_slow", "min_runs", WF.slow.minRuns),
      minRatio: floor("workflow_slow", "min_ratio", WF.slow.minRatio),
      minMedianMs: floor("workflow_slow", "min_median_ms", WF.slow.minMedianMs),
    },
    workflow_fixed_chain: {
      minRuns: floor("workflow_fixed_chain", "min_runs", WF.fixedChain.minRuns),
      minCoreSize: floor("workflow_fixed_chain", "min_core_size", WF.fixedChain.minCoreSize),
      minOrderStability: floor(
        "workflow_fixed_chain",
        "min_order_stability",
        WF.fixedChain.minOrderStability,
        true,
      ),
    },
    // A tool or task (`self-corrections/issues.ts`): of its turns, those with a self-correction.
    self_correcting: {
      minN: floor("self_correcting", "min_n", 20),
      minK: floor("self_correcting", "min_k", 5),
      minLow: floor("self_correcting", "min_low", 0.1, true),
    },
  } satisfies Record<SignalKind, Record<string, number>>;
}

/** The floors of every kind, as one value detectors take. */
export type Floors = ReturnType<typeof resolveFloors>;

export const DEFAULT_FLOORS: Floors = resolveFloors();

const SUBJECT_ROUTE_PHASE: Readonly<
  Record<SignalKind, readonly [SignalSubjectKind, SignalFixRoute, 1 | 2]>
> = {
  first_try_miss: ["tool", "rewrite_description", 1],
  buried_tool: ["tool", "adaptive_ranking", 1],
  magnet: ["tool", "rewrite_description", 1],
  dead_tool: ["project", "retire_tool", 1],
  sequence_chain: ["tool_pair", "workflow_skill", 1],
  sibling_confusion: ["tool_pair", "disambiguate_pair", 1],
  error_loop: ["tool", "show_turns", 1],
  no_follow_through: ["tool", "rewrite_description", 1],
  abandoned_search: ["project", "workflow_skill", 1],
  padding_share: ["project", "lower_top_k", 1],
  latency_outlier: ["tool", "none", 1],
  unstable_intent: ["query_cluster", "adaptive_ranking", 1],
  repeat_invoke: ["tool", "show_turns", 1],
  fragmented_intents: ["project", "run_extraction", 1],
  cooccurring_intents: ["tool_pair", "workflow_skill", 2],
  tool_switch: ["tool_pair", "disambiguate_pair", 1],
  empty_result: ["tool", "rewrite_description", 1],
  unknown_tool: ["tool", "show_turns", 1],
  unused_tool: ["project", "retire_tool", 1],
  long_turn: ["project", "show_turns", 1],
  blocked_action: ["tool", "show_turns", 1],
  identical_retry: ["tool", "show_turns", 1],
  wait_heavy: ["tool", "none", 1],
  token_heavy: ["project", "show_turns", 1],
  system_turn_failing: ["project", "show_turns", 1],
  agent_failing: ["project", "show_turns", 1],
  workflow_failing: ["workflow", "show_turns", 1],
  workflow_slow: ["workflow", "show_turns", 1],
  workflow_fixed_chain: ["workflow", "workflow_skill", 1],
  // Per tool, and per task with subject kind `workflow`; the route follows the pattern.
  self_correcting: ["tool", "show_turns", 1],
};

/** The catalog under a set of floors. */
export function buildSignalCatalog(
  floors: Floors = DEFAULT_FLOORS,
): Readonly<Record<SignalKind, SignalCatalogEntry>> {
  return Object.fromEntries(
    SIGNAL_KINDS.map((kind) => {
      const [subjectKind, fixRoute, phase] = SUBJECT_ROUTE_PHASE[kind];
      const entry: SignalCatalogEntry = {
        kind,
        subjectKind,
        tier: "deterministic",
        fixRoute,
        fixSafety: FIX_SAFETY[fixRoute],
        phase,
        floors: floors[kind],
      };
      return [kind, entry];
    }),
  ) as Record<SignalKind, SignalCatalogEntry>;
}

export const SIGNAL_CATALOG = buildSignalCatalog();

/** Kinds the Phase 1 engine emits. */
export const PHASE_1_KINDS: readonly SignalKind[] = SIGNAL_KINDS.filter(
  (kind) => SIGNAL_CATALOG[kind].phase === 1,
);

/** Only tools listed or run in at least this many turns take part in pair counting. */
export const PAIR_TOOL_MIN_TURNS = Math.floor(envNumber("TRACE_SIGNALS_PAIR_TOOL_MIN_TURNS", 20));

/** Evidence turn ids stored per signal. */
export const EVIDENCE_TURNS_STORED = 20;

/** Latency samples kept per tool (and for the project median). */
export const LATENCY_RESERVOIR_SIZE = 2_000;

/**
 * Distinct first-search query hashes one run keeps counters for
 * (`unstable_intent`). Past it the lowest-count hashes are evicted, which is
 * safe because the detector needs `min_n` turns per hash to fire.
 */
export const MAX_QUERY_HASHES = Math.floor(envNumber("TRACE_SIGNALS_MAX_QUERY_HASHES", 20_000));
