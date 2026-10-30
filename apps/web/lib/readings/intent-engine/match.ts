import { envNumber } from "@/lib/platform/env-number";
import { tokenizeForRelevance } from "@/lib/readings/intent-engine/text";
import {
  buildRelevanceIndex,
  type PreparedDocument,
  type PreparedQuery,
  type RelevanceIndex,
} from "@/lib/readings/query-intents/relevance";

/**
 * Where an ask goes: the cluster whose wording it restates, with the turn's
 * tools as a second witness.
 *
 * Wording is the adaptive-ranking matcher's rule with BM25 in place of
 * Jaccard: the best SYMMETRIC normalized relevance against any single member,
 * `max over members m of min(rel(ask → m), rel(m → ask))` (see
 * `lib/query-intents/bm25-clusterer.ts` for why per member and why both ways).
 * BM25 weighs rare words over common ones, which Jaccard at 0.5 cannot.
 *
 * Tools: the cosine between the capabilities the ask's turn ran and the
 * cluster's usage, each capability weighted by how few clusters use it, so a
 * tool every turn runs (`read_file`) links nothing. Two asks worded apart that
 * lead to the same tools are the paraphrases lexical matching misses.
 *
 * The rule, in order:
 *   - wording ≥ `strong`: join (unless a second cluster is within `margin`);
 *   - wording ≥ `weak` and tools ≥ `tools`: join;
 *   - otherwise a new cluster. Tools alone never join.
 *
 * Wording against a cluster is the mean of the ask's best few member scores
 * ({@link supportingMembers}), not its single best: matching on one member
 * alone chains, each joiner widening what the next can match.
 *
 * Containment (`containedIn`): which clusters' members an ask wholly holds.
 * The engine uses it only for an ask that reads as several requests.
 */

export interface MatchThresholds {
  strong: number;
  weak: number;
  tools: number;
  margin: number;
}

export const DEFAULT_THRESHOLDS: MatchThresholds = {
  strong: 0.6,
  weak: 0.3,
  tools: 0.5,
  margin: 0.1,
};

const unitInterval = (n: number) => n >= 0 && n <= 1;

/** Thresholds from env (`RATEL_INTENT_ENGINE_STRONG|WEAK|TOOLS|MARGIN`), defaults otherwise. */
export function thresholdsFromEnv(): MatchThresholds {
  return {
    strong: envNumber("RATEL_INTENT_ENGINE_STRONG", DEFAULT_THRESHOLDS.strong, unitInterval),
    weak: envNumber("RATEL_INTENT_ENGINE_WEAK", DEFAULT_THRESHOLDS.weak, unitInterval),
    tools: envNumber("RATEL_INTENT_ENGINE_TOOLS", DEFAULT_THRESHOLDS.tools, unitInterval),
    margin: envNumber("RATEL_INTENT_ENGINE_MARGIN", DEFAULT_THRESHOLDS.margin, unitInterval),
  };
}

/** What the index needs of a cluster. */
export interface MatchableCluster {
  key: string;
  members: readonly string[];
  /** Capability key (`tool:x`, `skill:x`) -> count. */
  usage: Readonly<Record<string, number>>;
  /** Tie-break: lower ranks first (bigger, older clusters). */
  rank: number;
}

export interface Candidate {
  key: string;
  wording: number;
  tools: number;
}

export type MatchResult =
  | { kind: "join"; key: string; wording: number; tools: number; by: "wording" | "tools" }
  | { kind: "new"; ambiguous: boolean };

interface Phrase {
  cluster: Entry;
  doc: PreparedDocument;
  /** The phrase as a query, for the reverse direction. Null when it has no terms. */
  query: PreparedQuery | null;
}

interface Entry {
  cluster: MatchableCluster;
  phrases: Phrase[];
}

/** Candidate phrases are drawn from the ask's rarest terms only; common ones are scored, not looked up. */
const LOOKUP_TERMS = 4;
/** Phrases scored per ask, at most, after the cheap prefilter. */
const MAX_SCORED_PHRASES = 2_000;

export interface ClusterIndex {
  match(text: string, capabilities: ReadonlySet<string>, thresholds?: MatchThresholds): MatchResult;
  /** Every cluster the ask scores above zero on, best wording first. For compaction, seeding and tests. */
  candidates(text: string, capabilities: ReadonlySet<string>): Candidate[];
  /** Add a cluster, or new members of one, so later asks in the same fold see them. */
  add(cluster: MatchableCluster, newMembers?: readonly string[]): void;
  /** Symmetric wording between two texts under this index's idf. */
  similarity(a: string, b: string): number;
  /** Clusters some member of which the text wholly contains (reverse relevance ≥ threshold), best first. */
  containedIn(text: string, threshold: number): string[];
}

/**
 * Build the index over a project's clusters. `extraText` (the fold's own asks,
 * the catalog vocabulary) only feeds idf, so an ask's terms are weighed against
 * the whole fold, as the BM25 clusterer weighs its candidates.
 */
export function buildClusterIndex(
  clusters: readonly MatchableCluster[],
  extraText: readonly string[] = [],
): ClusterIndex {
  const relevance: RelevanceIndex = buildRelevanceIndex([
    ...clusters.map((c) => ({ id: `c:${c.key}`, text: c.members.join("\n") })),
    ...extraText.map((text, i) => ({ id: `x:${i}`, text })),
  ]);
  const entries = new Map<string, Entry>();
  const postings = new Map<string, Phrase[]>();
  // How many clusters use each capability: a capability every cluster uses says nothing.
  const capabilityDf = new Map<string, number>();
  let clusterCount = 0;

  const postPhrase = (entry: Entry, text: string) => {
    const doc = relevance.prepareDocument(text);
    if (doc.length === 0) return;
    const phrase: Phrase = { cluster: entry, doc, query: relevance.prepareQuery(text) };
    entry.phrases.push(phrase);
    for (const term of doc.tf.keys()) {
      const list = postings.get(term);
      if (list) list.push(phrase);
      else postings.set(term, [phrase]);
    }
  };

  const counted = new Set<string>();
  const add = (cluster: MatchableCluster, newMembers?: readonly string[]) => {
    let entry = entries.get(cluster.key);
    if (!entry) {
      entry = { cluster, phrases: [] };
      entries.set(cluster.key, entry);
      clusterCount += 1;
      for (const member of cluster.members) postPhrase(entry, member);
    } else {
      entry.cluster = cluster;
      for (const member of newMembers ?? []) postPhrase(entry, member);
    }
    // Usage only grows: count each capability once per cluster that uses it.
    for (const cap of Object.keys(cluster.usage)) {
      const seenKey = `${cluster.key}\u0000${cap}`;
      if (counted.has(seenKey)) continue;
      counted.add(seenKey);
      capabilityDf.set(cap, (capabilityDf.get(cap) ?? 0) + 1);
    }
  };
  for (const cluster of clusters) add(cluster);

  const capabilityWeight = (cap: string): number => {
    const df = capabilityDf.get(cap) ?? 0;
    return Math.log(1 + (clusterCount - df + 0.5) / (df + 0.5));
  };

  const toolAgreement = (
    capabilities: ReadonlySet<string>,
    usage: Readonly<Record<string, number>>,
  ): number => {
    if (capabilities.size === 0) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (const cap of capabilities) {
      const w = capabilityWeight(cap);
      na += w * w;
      const count = usage[cap];
      if (count) dot += w * w * count;
    }
    for (const [cap, count] of Object.entries(usage)) {
      const w = capabilityWeight(cap) * count;
      nb += w * w;
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  };

  const score = (text: string, capabilities: ReadonlySet<string>): Candidate[] => {
    const query = relevance.prepareQuery(text);
    if (!query) return [];
    const askDoc = relevance.prepareDocument(text);
    // Look phrases up by the ask's rarest terms; a phrase sharing only common
    // words cannot reach the weak threshold and is never scored.
    const lookup = [...query.terms]
      .sort((a, b) => relevance.idf(b) - relevance.idf(a))
      .slice(0, LOOKUP_TERMS);
    const seen = new Set<Phrase>();
    for (const term of lookup) {
      for (const phrase of postings.get(term) ?? []) {
        seen.add(phrase);
        if (seen.size >= MAX_SCORED_PHRASES) break;
      }
      if (seen.size >= MAX_SCORED_PHRASES) break;
    }
    // Per cluster, the ask's wording against each member it shares a rare term with.
    const scores = new Map<string, number[]>();
    for (const phrase of seen) {
      const fwd = relevance.relevanceOf(query, phrase.doc);
      if (fwd <= 0) continue;
      const rev = phrase.query ? relevance.relevanceOf(phrase.query, askDoc) : 0;
      const key = phrase.cluster.cluster.key;
      const list = scores.get(key);
      if (list) list.push(Math.min(fwd, rev));
      else scores.set(key, [Math.min(fwd, rev)]);
    }
    const out: Candidate[] = [];
    for (const [key, list] of scores) {
      const entry = entries.get(key)!;
      // Not the single best member: the mean of the best few, so one member
      // that happens to bridge two asks cannot pull a cluster's vocabulary
      // ever wider (single-linkage chaining). Members not scored count as 0.
      const k = supportingMembers(entry.phrases.length);
      const top = list.sort((a, b) => b - a).slice(0, k);
      const wording = top.reduce((sum, w) => sum + w, 0) / k;
      if (wording <= 0) continue;
      out.push({ key, wording, tools: toolAgreement(capabilities, entry.cluster.usage) });
    }
    return out.sort(
      (x, y) =>
        y.wording - x.wording ||
        entries.get(x.key)!.cluster.rank - entries.get(y.key)!.cluster.rank ||
        x.key.localeCompare(y.key),
    );
  };

  /** Clusters whose some member is wholly contained in the ask (reverse relevance), best first. */
  const contained = (text: string, threshold: number): string[] => {
    const askDoc = relevance.prepareDocument(text);
    const query = relevance.prepareQuery(text);
    if (!query) return [];
    const keys = new Map<string, number>();
    const seen = new Set<Phrase>();
    for (const term of query.terms) for (const phrase of postings.get(term) ?? []) seen.add(phrase);
    for (const phrase of seen) {
      if (!phrase.query || phrase.query.terms.length < 3) continue;
      const rev = relevance.relevanceOf(phrase.query, askDoc);
      if (rev < threshold) continue;
      const key = phrase.cluster.cluster.key;
      keys.set(key, Math.max(keys.get(key) ?? 0, rev));
    }
    return [...keys.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([key]) => key);
  };

  return {
    add,
    candidates: score,
    containedIn: contained,
    similarity(a, b) {
      const qa = relevance.prepareQuery(a);
      const qb = relevance.prepareQuery(b);
      if (!qa || !qb) return 0;
      return Math.min(
        relevance.relevanceOf(qa, relevance.prepareDocument(b)),
        relevance.relevanceOf(qb, relevance.prepareDocument(a)),
      );
    },
    match(text, capabilities, thresholds = DEFAULT_THRESHOLDS) {
      const scored = score(text, capabilities);
      const [first, second] = scored;
      if (first && first.wording >= thresholds.strong) {
        const ambiguous =
          second !== undefined &&
          second.wording >= thresholds.strong &&
          first.wording - second.wording < thresholds.margin;
        // Two clusters restate the ask about equally well: the tools decide, or nobody does.
        if (!ambiguous)
          return {
            kind: "join",
            key: first.key,
            wording: first.wording,
            tools: first.tools,
            by: "wording",
          };
        const byTools = [first, second]
          .filter((c) => c.tools >= thresholds.tools)
          .sort((a, b) => b.tools - a.tools);
        if (byTools.length === 1) {
          const c = byTools[0];
          return { kind: "join", key: c.key, wording: c.wording, tools: c.tools, by: "tools" };
        }
        return { kind: "new", ambiguous: true };
      }
      const supported = scored
        .filter((c) => c.wording >= thresholds.weak && c.tools >= thresholds.tools)
        .sort((a, b) => b.tools - a.tools || b.wording - a.wording);
      if (supported[0]) {
        const c = supported[0];
        return { kind: "join", key: c.key, wording: c.wording, tools: c.tools, by: "tools" };
      }
      return { kind: "new", ambiguous: false };
    },
  };
}

/** How many of a cluster's members an ask must stand close to: 1 for up to 2, 2 for up to 4, then 3. */
export function supportingMembers(memberCount: number): number {
  return Math.max(1, Math.min(3, Math.ceil(memberCount / 2)));
}

/** Distinct stemmed terms, for callers comparing term sets. */
export function termsOf(text: string): string[] {
  return [...new Set(tokenizeForRelevance(text))];
}
