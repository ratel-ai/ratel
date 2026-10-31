import { clusterQueries, JACCARD_THRESHOLD, jaccard } from "@/lib/readings/text/cluster";
import type { DistinctAsk } from "@/lib/readings/topics/asks";

/**
 * Asks grouped by wording (`lib/text/cluster.ts`, the deterministic token-set
 * clustering), the raw material of new topics, and the name a topic gets from
 * its own asks when no model can name it. Pure.
 */

export interface WordingGroup {
  /** Stable within one reading: the busiest ask's hash. */
  key: string;
  /** Busiest first. */
  asks: DistinctAsk[];
  turns: number;
}

/** Groups of distinct asks by shared content words, busiest first. Asks arrive busiest first, so busy asks seed the groups. */
export function groupByWording(
  asks: readonly DistinctAsk[],
  threshold: number = JACCARD_THRESHOLD,
): WordingGroup[] {
  const assignments = clusterQueries(
    asks.map((ask) => ({ key: ask.hash, query: ask.key })),
    [],
    threshold,
  );
  const byCluster = new Map<string, DistinctAsk[]>();
  assignments.forEach((assignment, index) => {
    const cluster = assignment.kind === "new" ? assignment.clusterKey : assignment.existingId;
    const list = byCluster.get(cluster);
    if (list) list.push(asks[index]!);
    else byCluster.set(cluster, [asks[index]!]);
  });
  return [...byCluster.values()]
    .map((members) => ({
      key: members[0]!.hash,
      asks: members,
      turns: members.reduce((sum, ask) => sum + ask.turnIds.length, 0),
    }))
    .sort((a, b) => b.turns - a.turns || (a.key < b.key ? -1 : 1));
}

/** Content-word frequency across a group's asks, each ask weighted by its turns. */
function tokenWeights(asks: readonly DistinctAsk[]): Map<string, number> {
  const weights = new Map<string, number>();
  for (const ask of asks)
    for (const token of ask.tokens)
      weights.set(token, (weights.get(token) ?? 0) + ask.turnIds.length);
  return weights;
}

/**
 * The ask most like the rest of its group: the highest average weight of its
 * words across the group (then the busiest, then the shortest), so a short ask
 * of the shared words beats a long one that adds its own details.
 */
export function representativeAsk(asks: readonly DistinctAsk[]): DistinctAsk {
  const weights = tokenWeights(asks);
  const score = (ask: DistinctAsk) =>
    ask.tokens.size === 0
      ? 0
      : [...ask.tokens].reduce((sum, token) => sum + (weights.get(token) ?? 0), 0) /
        ask.tokens.size;
  return [...asks].sort(
    (a, b) =>
      score(b) - score(a) ||
      b.turnIds.length - a.turnIds.length ||
      a.text.length - b.text.length ||
      (a.key < b.key ? -1 : 1),
  )[0]!;
}

const MAX_NAME_WORDS = 6;
const MAX_NAME_CHARS = 48;
/** Short words ("up", "of", "the") that hold a name together; never the end of one. */
const CONNECTOR = /^[a-z]{1,3}$/;

const normalizeWord = (word: string) => word.toLowerCase().replace(/[^a-z0-9]+/g, "");
const hasDigit = (word: string) => /\d/.test(word);
const isConnector = (word: string) => CONNECTOR.test(normalizeWord(word));

function sentenceCase(words: readonly string[]): string {
  const trimmed = [...words];
  while (trimmed.length > 1 && isConnector(trimmed.at(-1)!)) trimmed.pop();
  const text = trimmed
    .join(" ")
    .replace(/[\s.,;:!?]+$/, "")
    .trim();
  const clipped =
    text.length > MAX_NAME_CHARS ? text.slice(0, MAX_NAME_CHARS).replace(/\s+\S*$/, "") : text;
  return clipped.charAt(0).toUpperCase() + clipped.slice(1);
}

/**
 * A topic's name from its own asks, for when no model names it. When the
 * words most of the group shares sit together in its representative ask
 * ("Check delivery status" in "Check delivery status of PO-26-1184", with
 * "check the delivery status for rebar" beside it), those words. Otherwise
 * the representative ask itself, without words that carry digits (order
 * numbers, ids), cut to six words.
 */
export function wordsName(asks: readonly DistinctAsk[]): string {
  const representative = representativeAsk(asks);
  const words = representative.text.split(/\s+/).filter(Boolean);
  const counts = new Map<string, number>();
  for (const ask of asks)
    for (const token of ask.tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  const bar = Math.max(2, Math.ceil(asks.length / 2));
  const shared = words.map((word) => {
    const token = normalizeWord(word);
    return token.length >= 3 && !hasDigit(word) && (counts.get(token) ?? 0) >= bar;
  });
  // The longest run of shared words, short words inside it allowed ("look up task").
  let best: { from: number; to: number; content: number } | null = null;
  let from = -1;
  let content = 0;
  words.forEach((word, index) => {
    const inside = shared[index] || (from >= 0 && isConnector(word));
    if (!inside) {
      from = -1;
      content = 0;
      return;
    }
    if (from < 0) from = index;
    if (shared[index]) {
      content += 1;
      if (!best || content > best.content) best = { from, to: index, content };
    }
  });
  const run = best as { from: number; to: number; content: number } | null;
  if (asks.length >= 2 && run && run.content >= 2)
    return sentenceCase(words.slice(run.from, run.to + 1).slice(0, MAX_NAME_WORDS));
  const plain = words.filter((word) => !hasDigit(word)).slice(0, MAX_NAME_WORDS);
  return sentenceCase(plain.length > 0 ? plain : words.slice(0, MAX_NAME_WORDS));
}

/** How alike an ask is to a set of member asks: its best content-word overlap with any of them. */
export function bestOverlap(
  tokens: ReadonlySet<string>,
  members: readonly ReadonlySet<string>[],
): number {
  let best = 0;
  const own = tokens as Set<string>;
  for (const member of members) {
    const overlap = jaccard(own, member as Set<string>);
    if (overlap > best) best = overlap;
  }
  return best;
}
