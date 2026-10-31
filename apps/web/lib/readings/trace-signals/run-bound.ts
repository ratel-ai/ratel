import type { SignalKind } from "@/lib/readings/trace-signals/view";

/**
 * Kinds read from what happened inside one run (its first search, its repeats,
 * its order of calls, how it ended), so meaningless when runs hold several
 * users' calls. Kinds read per search or per call stay.
 */
export const RUN_BOUND_KINDS: ReadonlySet<SignalKind> = new Set<SignalKind>([
  "first_try_miss",
  "sequence_chain",
  "error_loop",
  "no_follow_through",
  "abandoned_search",
  "unstable_intent",
  "repeat_invoke",
  "fragmented_intents",
  "cooccurring_intents",
  "tool_switch",
  "long_turn",
  "self_correcting",
]);
