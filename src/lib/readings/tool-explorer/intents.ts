import { envNumber } from "@/lib/platform/env-number";
import { buildRelevanceIndex, tokenizeForRelevance } from "@/lib/readings/query-intents/relevance";
import { labelForFreq, tokenize } from "@/lib/readings/text/cluster";
import { SURE_HOP_P } from "@/lib/readings/tool-explorer/thresholds";
import type {
  ExplorerScope,
  ExplorerUnit,
  IntentGroup,
  IntentToolShare,
  StoredIntentChain,
  StoredIntentEdge,
  StoredIntentFirst,
} from "@/lib/readings/tool-explorer/types";
import { sortedDistinct } from "@/lib/readings/tool-explorer/units";
import { wilsonLow } from "@/lib/readings/trace-signals/signals/severity";

/**
 * The intent side of a reading. Intents are the `query_intents` rows the
 * categorize job already extracted from a turn's searches; the explorer only
 * joins them to the turn's tool calls. Three things come out of it:
 *
 * - per (scope, intent): which tools the units carrying the intent called,
 *   as a share with its Wilson lower bound;
 * - intent units: a unit's distinct intents, in the order their searches ran,
 *   so the transition and co-usage machinery runs over intents as it does
 *   over tools;
 * - intent groups: intents whose texts say the same thing, grouped greedily
 *   by the same symmetric BM25 relevance the categorize job clusters with
 *   (`bm25-clusterer.ts`), at a lower bar so a group is a coarser view of
 *   the intents. Lexical by decision (RC-195): no embeddings.
 */

/** An intent needs this many units before its tool shares are stored. */
export const MIN_INTENT_UNITS = Math.floor(envNumber("TOOL_EXPLORER_MIN_INTENT_UNITS", 5));
/**
 * Symmetric relevance at or above this puts two intents in one group. The
 * categorize job merges intents at 0.6; a group sits below that on purpose,
 * so it joins what the job kept apart as distinct phrasings of one ask.
 */
export const INTENT_GROUP_RELEVANCE = envNumber(
  "TOOL_EXPLORER_INTENT_GROUP_RELEVANCE",
  0.4,
  (n) => n > 0 && n <= 1,
);
export const MAX_INTENT_GROUPS = 200;

/** A unit whose "calls" are its intents, first appearance order, repeats collapsed. */
export function intentUnitOf(
  unit: Pick<ExplorerUnit, "id" | "sessionId">,
  intentIds: readonly string[],
): ExplorerUnit {
  const calls: string[] = [];
  const seen = new Set<string>();
  for (const id of intentIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    calls.push(id);
  }
  return {
    id: unit.id,
    sessionId: unit.sessionId,
    calls,
    items: sortedDistinct(calls),
  };
}

interface IntentCount {
  units: number;
  tools: Map<string, number>;
  /** Ordered call chains of the units that carried the intent, by occurrence; keyed `a>b>c`. */
  chains: Map<string, number>;
  /** Consecutive calls a then b in those units, keyed `a>b`, and how many times a was called at all. */
  next: Map<string, number>;
  outs: Map<string, number>;
  /** The unit's first call, by tool. */
  firsts: Map<string, number>;
  /** Calls across the units (repeats collapsed), for calls per unit and the ask's cost. */
  calls: number;
}

/** First calls shown per intent. */
export const FIRSTS_SHOWN = 3;

/** Edges kept per intent, by count. */
export const MAX_EDGES_PER_INTENT = 60;

/** A chain longer than this is cut after its first calls. */
export const MAX_CHAIN_CALLS = 6;
/** Distinct chains kept per intent; past this, new shapes are not counted. */
export const MAX_CHAINS_PER_INTENT = 200;
/** Chains shown per intent. */
export const CHAINS_SHOWN = 2;

export interface IntentToolStats {
  scope: ExplorerScope;
  byIntent: Map<string, IntentCount>;
}

export function createIntentToolStats(scope: ExplorerScope): IntentToolStats {
  return { scope, byIntent: new Map() };
}

/** Count one unit: every intent it carried saw every tool it called. */
export function countIntentTools(
  stats: IntentToolStats,
  intentIds: readonly string[],
  tools: readonly string[],
  /** The unit's calls in order (repeats collapsed), for the chain per intent. */
  calls: readonly string[] = [],
): void {
  if (intentIds.length === 0 || tools.length === 0) return;
  const chainKey = calls.length > 0 ? calls.slice(0, MAX_CHAIN_CALLS).join(">") : null;
  for (const intentId of new Set(intentIds)) {
    let count = stats.byIntent.get(intentId);
    if (!count) {
      count = {
        units: 0,
        tools: new Map(),
        chains: new Map(),
        next: new Map(),
        outs: new Map(),
        firsts: new Map(),
        calls: 0,
      };
      stats.byIntent.set(intentId, count);
    }
    count.units += 1;
    count.calls += calls.length;
    if (calls.length > 0) count.firsts.set(calls[0]!, (count.firsts.get(calls[0]!) ?? 0) + 1);
    for (const tool of tools) count.tools.set(tool, (count.tools.get(tool) ?? 0) + 1);
    if (
      chainKey !== null &&
      (count.chains.has(chainKey) || count.chains.size < MAX_CHAINS_PER_INTENT)
    ) {
      count.chains.set(chainKey, (count.chains.get(chainKey) ?? 0) + 1);
    }
    // Every call of a is a chance for b to follow; the unit's last call, which nothing follows, counts against every hop out of it.
    for (let i = 0; i < calls.length; i += 1) {
      count.outs.set(calls[i]!, (count.outs.get(calls[i]!) ?? 0) + 1);
      if (i + 1 >= calls.length) continue;
      const key = `${calls[i]}>${calls[i + 1]}`;
      count.next.set(key, (count.next.get(key) ?? 0) + 1);
    }
  }
}

/**
 * The commonest ordered chains per intent with enough units: "for this ask
 * the agent ran A then B then C, in N of its units". Chains seen once are
 * noise and left out; at most `CHAINS_SHOWN` per intent, by count.
 */
export function finishIntentChains(
  stats: IntentToolStats,
  minUnits: number = MIN_INTENT_UNITS,
): Record<string, StoredIntentChain[]> {
  const out: Record<string, StoredIntentChain[]> = {};
  for (const [intentId, count] of stats.byIntent) {
    if (count.units < minUnits) continue;
    const chains = [...count.chains.entries()]
      .filter(([, n]) => n >= 2)
      .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
      .slice(0, CHAINS_SHOWN)
      .map(([key, n]) => ({ t: key.split(">"), n }));
    if (chains.length > 0) out[intentId] = chains;
  }
  return out;
}

/**
 * The next-call edges per intent with enough units: a then b, how often, and
 * how many times a was called at all, so a reader can take "of a's calls, b
 * came next in n" within this ask. (A unit's last call counts against every
 * hop out of it: a dependency means b *always* follows.) Edges
 * seen once are left out; at most `MAX_EDGES_PER_INTENT`.
 */
export function finishIntentEdges(
  stats: IntentToolStats,
  minUnits: number = MIN_INTENT_UNITS,
): Record<string, StoredIntentEdge[]> {
  const out: Record<string, StoredIntentEdge[]> = {};
  for (const [intentId, count] of stats.byIntent) {
    if (count.units < minUnits) continue;
    // Sure hops first, so the cap never drops a dependency for a busy pair with no order.
    const edges = [...count.next.entries()]
      .filter(([, n]) => n >= 2)
      .map(([key, n]) => {
        const [a, b] = key.split(">") as [string, string];
        return { a, b, n, na: count.outs.get(a) ?? n };
      })
      .sort(
        (x, y) =>
          Number(y.n / y.na >= SURE_HOP_P) - Number(x.n / x.na >= SURE_HOP_P) ||
          y.n - x.n ||
          (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1),
      )
      .slice(0, MAX_EDGES_PER_INTENT);
    if (edges.length > 0) out[intentId] = edges;
  }
  return out;
}

/** Calls per intent with enough units, for calls per unit and the ask's cost. */
export function finishIntentCalls(
  stats: IntentToolStats,
  minUnits: number = MIN_INTENT_UNITS,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [intentId, count] of stats.byIntent)
    if (count.units >= minUnits && count.calls > 0) out[intentId] = count.calls;
  return out;
}

/**
 * What each intent's units called first, the commonest first calls only: "for
 * this ask the agent opens with A in n of its units".
 */
export function finishIntentFirsts(
  stats: IntentToolStats,
  minUnits: number = MIN_INTENT_UNITS,
): Record<string, StoredIntentFirst[]> {
  const out: Record<string, StoredIntentFirst[]> = {};
  for (const [intentId, count] of stats.byIntent) {
    if (count.units < minUnits) continue;
    const firsts = [...count.firsts.entries()]
      .filter(([, n]) => n >= 2)
      .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
      .slice(0, FIRSTS_SHOWN)
      .map(([t, n]) => ({ t, n }));
    if (firsts.length > 0) out[intentId] = firsts;
  }
  return out;
}

/** Shares for intents with enough units, biggest intents and shares first. */
export function finishIntentTools(
  stats: IntentToolStats,
  minUnits: number = MIN_INTENT_UNITS,
): IntentToolShare[] {
  const out: IntentToolShare[] = [];
  for (const [intentId, count] of stats.byIntent) {
    if (count.units < minUnits) continue;
    for (const [toolId, n] of count.tools) {
      out.push({
        scope: stats.scope,
        intentId,
        intentUnits: count.units,
        toolId,
        n,
        share: n / count.units,
        shareLow: wilsonLow(n, count.units),
      });
    }
  }
  return out.sort(
    (x, y) =>
      y.intentUnits - x.intentUnits ||
      (x.intentId < y.intentId
        ? -1
        : x.intentId > y.intentId
          ? 1
          : y.n - x.n || (x.toolId < y.toolId ? -1 : 1)),
  );
}

/**
 * Greedy single-pass grouping: each intent (most units first) joins the group
 * holding the phrase it matches best, when that match clears the threshold,
 * else opens one. The match is the symmetric relevance of the clusterer,
 * `min(rel(a → b), rel(b → a))`, scored on a BM25 index over every intent
 * text so idf reflects this project's vocabulary; groups are shortlisted by a
 * shared stemmed token, never scored as one long document. The label is the
 * group's three commonest content words. Deterministic for the same input.
 */
export function groupIntents(
  intents: readonly { id: string; text: string; units: number }[],
  threshold: number = INTENT_GROUP_RELEVANCE,
  maxGroups: number = MAX_INTENT_GROUPS,
): IntentGroup[] {
  const ordered = [...intents]
    .filter((intent) => intent.text.trim().length > 0)
    .sort((x, y) => y.units - x.units || (x.id < y.id ? -1 : 1));
  const index = buildRelevanceIndex(
    ordered.map((intent) => ({ id: intent.id, text: intent.text })),
  );
  interface Group {
    phrases: string[];
    freq: Map<string, number>;
    intentIds: string[];
  }
  const groups: Group[] = [];
  const byStem = new Map<string, Set<Group>>();
  const symmetric = (a: string, b: string) =>
    Math.min(index.relevanceBetween(a, b), index.relevanceBetween(b, a));
  for (const intent of ordered) {
    const stems = new Set(tokenizeForRelevance(intent.text));
    if (stems.size === 0) continue;
    const shortlist = new Set<Group>();
    for (const stem of stems) for (const group of byStem.get(stem) ?? []) shortlist.add(group);
    let best: Group | null = null;
    let bestScore = 0;
    // Groups in creation order so an equal score goes to the earlier (bigger) one.
    for (const group of groups) {
      if (!shortlist.has(group)) continue;
      let score = 0;
      for (const phrase of group.phrases) score = Math.max(score, symmetric(intent.text, phrase));
      if (score >= threshold && score > bestScore) {
        best = group;
        bestScore = score;
      }
    }
    if (!best) {
      if (groups.length >= maxGroups) continue;
      best = { phrases: [], freq: new Map(), intentIds: [] };
      groups.push(best);
    }
    best.intentIds.push(intent.id);
    best.phrases.push(intent.text);
    for (const stem of stems) {
      let set = byStem.get(stem);
      if (!set) byStem.set(stem, (set = new Set()));
      set.add(best);
    }
    for (const token of new Set(tokenize(intent.text)))
      best.freq.set(token, (best.freq.get(token) ?? 0) + 1);
  }
  return groups.map((group, index) => ({
    id: `g${index + 1}`,
    label: labelForFreq(group.freq),
    intentIds: group.intentIds,
  }));
}
