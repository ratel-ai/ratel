import { type Config, getConfig } from "@/config";
import type {
  SignalFixRoute,
  SignalKind,
  SignalSubjectKind,
  SignalTier,
} from "@/lib/readings/trace-signals/view";
import { SIGNAL_KINDS } from "@/lib/readings/trace-signals/view";

/**
 * The signal catalog: the single source of truth for every kind the engine can
 * emit and the page can render. Floors are configurable
 * (`traceSignals.floors.<kind>.<floor>` in `web/src/config.ts`, with their defaults)
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
  /** Every floor the detector reads, from the config. */
  floors: Readonly<Record<string, number>>;
}

/** Every detector's floors, from the config. Exported so tests can resolve them
 * again under their own config. */
export function resolveFloors(config: Pick<Config, "traceSignals"> = getConfig()) {
  return config.traceSignals.floors satisfies Record<SignalKind, Record<string, number>>;
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
export const PAIR_TOOL_MIN_TURNS = getConfig().traceSignals.pairToolMinTurns;

/** Evidence turn ids stored per signal. */
export const EVIDENCE_TURNS_STORED = 20;

/** Latency samples kept per tool (and for the project median). */
export const LATENCY_RESERVOIR_SIZE = 2_000;

/**
 * Distinct first-search query hashes one run keeps counters for
 * (`unstable_intent`). Past it the lowest-count hashes are evicted, which is
 * safe because the detector needs `min_n` turns per hash to fire.
 */
export const MAX_QUERY_HASHES = getConfig().traceSignals.maxQueryHashes;
