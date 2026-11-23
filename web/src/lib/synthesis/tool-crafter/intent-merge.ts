import type { StoredTopicPattern } from "@/lib/readings/topics/types";
import { wilsonLow } from "@/lib/readings/trace-signals/signals/severity";
import {
  FIXED_PAIR_ORDER,
  runsInFixedOrder,
} from "@/lib/readings/trace-signals/workflows/fixed-order";
import {
  MAX_PROPOSALS_PER_RUN,
  type MergeCandidate,
} from "@/lib/synthesis/tool-crafter/candidates";

/**
 * Merges found in one intent's own pattern (ported from #267's
 * `pickAskMergeCandidates`, keyed on our Intents instead of Tool Explorer's
 * asks). Project-wide pairs miss these: a pair in 50 of one intent's 54
 * turns can be a few percent of all turns, under the "always together" bar.
 * Pure.
 */

/** One intent (a topic of Intents) as the crafter reads it: its turns and its stored tool pattern. */
export interface IntentPatternFact {
  topicId: string;
  turns: number;
  pattern: Pick<StoredTopicPattern, "tools" | "runs" | "inOrder">;
}

/** An intent's two-tool pattern is proposed as a merge from this many turns running both... */
export const INTENT_MERGE_MIN_RUNS = 10;
/** ...in at least this share of the intent's turns. */
export const INTENT_MERGE_MIN_SHARE = 0.5;

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The intent's two tools, when its pattern is exactly two tools, neither a skill. */
export function intentPair(intent: IntentPatternFact): [string, string] | null {
  const [first, second, ...rest] = intent.pattern.tools;
  if (!first || !second || rest.length > 0) return null;
  if (first.id.startsWith("skill:") || second.id.startsWith("skill:")) return null;
  return [first.id, second.id];
}

/**
 * Merge candidates from intents' own patterns: exactly two pattern tools, run
 * together in at least `INTENT_MERGE_MIN_RUNS` turns and in at least
 * `INTENT_MERGE_MIN_SHARE` of the intent's turns, in a fixed order by the one
 * rule read for a pair (`FIXED_PAIR_ORDER`, over the turns that ran both: at
 * least 20 of them, nine in ten in order, so the rule's runs bind before the
 * ten here). The intent rides along as evidence, by id. One proposal per
 * tool, most turns first; a tool another proposal took is skipped, so a
 * project-wide merge of the same two tools (nominated first) wins and the two
 * are one change.
 */
export function pickIntentMergeCandidates(
  intents: readonly IntentPatternFact[],
  taken: ReadonlySet<string> = new Set(),
  opts: { minRuns?: number; minShare?: number; max?: number } = {},
): MergeCandidate[] {
  const minRuns = opts.minRuns ?? INTENT_MERGE_MIN_RUNS;
  const minShare = opts.minShare ?? INTENT_MERGE_MIN_SHARE;
  const found: MergeCandidate[] = [];
  for (const intent of intents) {
    const pair = intentPair(intent);
    const { tools, runs, inOrder } = intent.pattern;
    if (!pair || runs < minRuns || intent.turns <= 0 || runs / intent.turns < minShare) continue;
    if (
      !runsInFixedOrder({ runs, coreTools: pair, orderStability: inOrder / runs }, FIXED_PAIR_ORDER)
    )
      continue;
    const unitsA = Math.max(tools[0]!.turns, runs);
    const unitsB = Math.max(tools[1]!.turns, runs);
    const either = Math.max(runs, unitsA + unitsB - runs);
    found.push({
      a: pair[0],
      b: pair[1],
      evidence: {
        scope: "turn",
        support: runs,
        unitsA,
        unitsB,
        jaccard: runs / either,
        jaccardLow: wilsonLow(runs, either),
        pAb: runs / unitsA,
        pBa: runs / unitsB,
        // The share of the turns running both that ran a first (anywhere before b), the order the pattern reads.
        nextP: inOrder / runs,
        orderAb: inOrder,
        orderBa: runs - inOrder,
        exampleSessions: [],
        intent: { topicId: intent.topicId, turns: intent.turns, runs },
      },
    });
  }
  const out: MergeCandidate[] = [];
  const used = new Set(taken);
  const topicOf = (candidate: MergeCandidate) => candidate.evidence.intent?.topicId ?? "";
  const ranked = found.sort(
    (x, y) =>
      y.evidence.support - x.evidence.support ||
      compareIds(x.a, y.a) ||
      compareIds(x.b, y.b) ||
      compareIds(topicOf(x), topicOf(y)),
  );
  for (const candidate of ranked) {
    if (used.has(candidate.a) || used.has(candidate.b)) continue;
    out.push(candidate);
    used.add(candidate.a);
    used.add(candidate.b);
    if (out.length >= (opts.max ?? MAX_PROPOSALS_PER_RUN)) break;
  }
  return out;
}
