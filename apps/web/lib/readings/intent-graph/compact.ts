import { IntentGraph } from "@ratel-ai/sdk";
import type { IntentGraphDocument, IntentGraphIntent } from "@/lib/readings/intent-types/wire";

/**
 * Edge-anchored compaction of a Cloud-built intent graph (RC-208).
 *
 * The lexical tier clusters on per-member word overlap, and subject nouns
 * dominate that overlap: "search tasks about X" and "search tasks for Y" seed
 * two clusters, each with support 1, each boosting `search_tasks` at a third of
 * full weight. This pass merges such fragments after the fold.
 *
 * The merge signal is the edges, not the wording. A cluster's only output is
 * its edge distribution, so two clusters that agree on it produce the same
 * boost merged or apart; merging them cannot change what the ranker says, only
 * how confidently (support) it says it. Wording is a second, weaker gate that
 * keeps a one-off ("failing tests on main" that happened to invoke
 * `search_tasks`) from being absorbed into an intent it does not share. Both
 * gates are checked between each absorbed cluster and the survivor it joins,
 * never through a third cluster.
 *
 * Only fragments below full weight that have gone quiet are absorbed (see
 * [`COMPACT_SETTLE_MS`]); a mature cluster is already ranked at full weight and
 * a fresh one may still be learning which tools its asks lead to.
 *
 * Nothing here calls a model or an embedder. Centroid-bearing clusters are
 * never touched: a dense boundary was drawn by a model Cloud does not have.
 *
 * The output goes through the SDK's own `IntentGraph.fromJson(..).toJson()`,
 * which rejects any invariant the merge might have broken and recomputes each
 * cluster's `label` and `terms` as the learner would.
 *
 * Privacy: members are raw user queries. This module never logs.
 */

/** Confirmed observations at which the ranker gives a cluster full weight (SDK `SUPPORT_FULL`). */
export const SUPPORT_FULL = 3;
/** Cosine between two clusters' edge weight vectors at or above which they agree. */
export const EDGE_AGREEMENT = 0.9;
/** Shared content tokens between two clusters' bags that bridge them. */
export const BRIDGE_MIN_SHARED = 2;
/** Jaccard between one member of each cluster that bridges them on its own. */
export const BRIDGE_TAU = 0.3;
/** Members kept per cluster (SDK `MEMBER_CAP`). The SDK only trims on observe, so the merge trims. */
export const MEMBER_CAP = 50;
/**
 * How long a cluster must have been quiet before it may be absorbed. Edge
 * agreement at one observation each is weak evidence: on a dense replay,
 * merging fragments the moment they appeared pooled edges that went on to
 * diverge and cost 1.3 points of recall@1, while merging the same graph once
 * its fragments had settled gained 1.8. A fragment not re-asked for a week is
 * unlikely to still be learning its mix. The Cloud fold stamps `last_ts` with
 * fold time, so this is a week of folds, not of event time.
 */
export const COMPACT_SETTLE_MS = 7 * 86_400_000;

export interface CompactionGroup {
  survivor: string;
  absorbed: string[];
  /** The kind-prefixed capability the group agrees on, e.g. `tool:search_tasks`. */
  capability: string;
}

export interface CompactionReport {
  before: number;
  after: number;
  merged: number;
  groups: CompactionGroup[];
}

export interface CompactionResult {
  graph: IntentGraphDocument;
  report: CompactionReport;
}

export interface CompactionOptions {
  /**
   * How long a cluster must have been quiet (graph `built_from_ts` minus its
   * `last_ts`) before it may be absorbed, so a fragment still learning keeps
   * its own edges. Default [`COMPACT_SETTLE_MS`]; 0 absorbs at once.
   */
  settleMs?: number;
}

/**
 * Merge immature clusters that agree on their edges and share wording. Returns
 * the same document object when nothing merges, so callers can compare by
 * identity. Throws when the SDK rejects the merged document; the caller keeps
 * the uncompacted graph in that case.
 */
export function compactIntentGraph(
  graph: IntentGraphDocument,
  options: CompactionOptions = {},
): CompactionResult {
  const intents = graph.intents;
  const merged = compactIntents(intents, graph.built_from_ts, options);
  if (merged.groups.length === 0) {
    return {
      graph,
      report: { before: intents.length, after: intents.length, merged: 0, groups: [] },
    };
  }
  const compacted: IntentGraphDocument = { ...graph, intents: merged.intents };
  // The SDK validates the merged document and recomputes every cluster's label
  // and terms. Only those two come back from it: the wire contract is additive
  // and an older SDK drops fields it does not know (`surfaced_*` on 0.12), so
  // the stored document stays the merged one with the labels grafted on.
  const relabelled = JSON.parse(
    IntentGraph.fromJson(JSON.stringify(compacted)).toJson(),
  ) as IntentGraphDocument;
  const labels = new Map(relabelled.intents.map((it) => [it.id, it]));
  const graphOut: IntentGraphDocument = {
    ...compacted,
    intents: compacted.intents.map((intent) => {
      const fresh = labels.get(intent.id);
      return fresh ? { ...intent, label: fresh.label, terms: fresh.terms } : intent;
    }),
  };
  return {
    graph: graphOut,
    report: {
      before: intents.length,
      after: graphOut.intents.length,
      merged: merged.absorbed,
      groups: merged.groups,
    },
  };
}

export interface CompactedIntents<T extends IntentGraphIntent> {
  /** The clusters after merging, in input order, absorbed ones removed. */
  intents: T[];
  groups: CompactionGroup[];
  /** Clusters absorbed into a survivor. */
  absorbed: number;
}

/**
 * The merge pass on its own, with no SDK: the same gates and star grouping
 * {@link compactIntentGraph} applies, over any cluster shaped like a wire
 * intent. A survivor keeps every field it carried beyond the wire ones, so the
 * Cloud intent engine can run it over its own clusters. Labels and terms are
 * left as they were; relabelling is the caller's.
 */
export function compactIntents<T extends IntentGraphIntent>(
  intents: readonly T[],
  builtFromTs: number,
  options: CompactionOptions = {},
): CompactedIntents<T> {
  const settleMs = options.settleMs ?? COMPACT_SETTLE_MS;
  const settledBefore = builtFromTs - settleMs;
  const absorbable = (intent: IntentGraphIntent): boolean =>
    intent.support < SUPPORT_FULL && (settleMs === 0 || (intent.last_ts ?? 0) <= settledBefore);
  const noop = (): CompactedIntents<T> => ({ intents: [...intents], groups: [], absorbed: 0 });
  if (intents.length < 2) return noop();

  const views = intents.map((intent, index) => viewOf(intent, index));
  const byTop = new Map<string, IntentView[]>();
  for (const view of views) {
    if (view.top === null) continue;
    const list = byTop.get(view.top);
    if (list) list.push(view);
    else byTop.set(view.top, [view]);
  }

  // Star clustering: the strongest cluster in each capability group claims every
  // candidate that passes both gates against it directly. Grouping is not
  // transitive on purpose: A~B and B~C never put C into A unless C also passes
  // against A, so a bridge that is not absorbed itself cannot glue two
  // strangers together.
  const assigned = new Set<number>();
  const absorbedIndexes = new Set<number>();
  const mergedByIndex = new Map<number, IntentGraphIntent>();
  const groups: CompactionGroup[] = [];
  for (const group of [...byTop.entries()].sort(([a], [b]) => compareIds(a, b)).map(([, g]) => g)) {
    if (group.length < 2) continue;
    const ordered = group.slice().sort(bySurvivorPreference);
    for (const survivor of ordered) {
      if (assigned.has(survivor.index)) continue;
      // A dense boundary belongs to the model that drew it: never absorbs, never absorbed.
      if (survivor.hasCentroid) {
        assigned.add(survivor.index);
        continue;
      }
      // A fresh fragment may still be learning its mix: it neither absorbs nor is absorbed.
      const mature = survivor.intent.support >= SUPPORT_FULL;
      if (!mature && !absorbable(survivor.intent)) continue;
      const absorbed = ordered
        .filter(
          (v) =>
            v !== survivor &&
            !assigned.has(v.index) &&
            !v.hasCentroid &&
            absorbable(v.intent) &&
            passesGates(survivor, v),
        )
        .sort((a, b) => compareIds(a.intent.id, b.intent.id));
      assigned.add(survivor.index);
      if (absorbed.length === 0) continue;
      for (const v of absorbed) {
        assigned.add(v.index);
        absorbedIndexes.add(v.index);
      }
      mergedByIndex.set(
        survivor.index,
        mergeInto(
          survivor.intent,
          absorbed.map((v) => v.intent),
        ),
      );
      groups.push({
        survivor: survivor.intent.id,
        absorbed: absorbed.map((v) => v.intent.id),
        capability: survivor.top!,
      });
    }
  }
  if (groups.length === 0) return noop();

  return {
    intents: intents
      .map((intent, index) => (mergedByIndex.get(index) as T | undefined) ?? intent)
      .filter((_, index) => !absorbedIndexes.has(index)),
    groups,
    absorbed: absorbedIndexes.size,
  };
}

/* — merge arithmetic ———————————————————————————————————————————————————————— */

function mergeInto(
  survivor: IntentGraphIntent,
  absorbed: readonly IntentGraphIntent[],
): IntentGraphIntent {
  // Survivor's members first, then the absorbed clusters newest-first, so the
  // cap drops the oldest evidence rather than the freshest.
  const newestFirst = absorbed
    .slice()
    .sort((a, b) => (b.last_ts ?? 0) - (a.last_ts ?? 0) || compareIds(a.id, b.id));
  const members: string[] = [];
  const seen = new Set<string>();
  for (const source of [survivor, ...newestFirst]) {
    for (const member of source.members) {
      if (seen.has(member)) continue;
      seen.add(member);
      members.push(member);
      if (members.length >= MEMBER_CAP) break;
    }
    if (members.length >= MEMBER_CAP) break;
  }
  const all = [survivor, ...absorbed];
  const support = all.reduce((sum, it) => sum + it.support, 0);
  const seeded = all.reduce((sum, it) => sum + (it.seeded_support ?? 0), 0);
  const lastTs = all.reduce<number | undefined>((max, it) => {
    if (it.last_ts === undefined) return max;
    return max === undefined ? it.last_ts : Math.max(max, it.last_ts);
  }, undefined);
  const merged: IntentGraphIntent = {
    ...survivor,
    members,
    support,
    tools: sumMaps(all.map((it) => it.tools)),
    skills: sumMaps(all.map((it) => it.skills)),
  };
  if (seeded > 0) merged.seeded_support = seeded;
  else delete merged.seeded_support;
  if (lastTs !== undefined) merged.last_ts = lastTs;
  const surfacedTools = sumMaps(all.map((it) => it.surfaced_tools ?? {}));
  const surfacedSkills = sumMaps(all.map((it) => it.surfaced_skills ?? {}));
  if (Object.keys(surfacedTools).length > 0) merged.surfaced_tools = surfacedTools;
  else delete merged.surfaced_tools;
  if (Object.keys(surfacedSkills).length > 0) merged.surfaced_skills = surfacedSkills;
  else delete merged.surfaced_skills;
  return merged;
}

function sumMaps(maps: readonly Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const map of maps) {
    for (const [key, value] of Object.entries(map)) {
      if (!(value > 0)) continue;
      out[key] = (out[key] ?? 0) + value;
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => compareIds(a, b)));
}

/* — the two gates ——————————————————————————————————————————————————————————— */

interface IntentView {
  index: number;
  intent: IntentGraphIntent;
  /** Kind-prefixed capability -> weight, tools and skills together. */
  edges: Map<string, number>;
  /** The heaviest edge, or null for a cluster with none. */
  top: string | null;
  hasCentroid: boolean;
  /** One token set per member, ID-like tokens removed. */
  memberBags: Set<string>[];
  /** Union of `memberBags`. */
  bag: Set<string>;
}

function viewOf(intent: IntentGraphIntent, index: number): IntentView {
  const edges = new Map<string, number>();
  for (const [id, w] of Object.entries(intent.tools)) if (w > 0) edges.set(`tool:${id}`, w);
  for (const [id, w] of Object.entries(intent.skills)) if (w > 0) edges.set(`skill:${id}`, w);
  let top: string | null = null;
  let topWeight = 0;
  for (const [key, w] of [...edges].sort(([a], [b]) => compareIds(a, b))) {
    if (w > topWeight) {
      top = key;
      topWeight = w;
    }
  }
  const memberBags = intent.members.map((m) => new Set(bridgeTokens(m)));
  const bag = new Set<string>();
  for (const b of memberBags) for (const t of b) bag.add(t);
  return {
    index,
    intent,
    edges,
    top,
    hasCentroid: Array.isArray(intent.centroid) && intent.centroid.length > 0,
    memberBags,
    bag,
  };
}

/**
 * Both merge gates between a survivor and a candidate: edge agreement and a
 * wording bridge. Every absorbed cluster passes this against its survivor.
 */
export function passesCompactionGates(
  survivor: IntentGraphIntent,
  candidate: IntentGraphIntent,
): boolean {
  return passesGates(viewOf(survivor, 0), viewOf(candidate, 1));
}

function passesGates(a: IntentView, b: IntentView): boolean {
  return edgeCosine(a.edges, b.edges) >= EDGE_AGREEMENT && bridged(a, b);
}

export function edgeCosine(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [key, w] of a) {
    na += w * w;
    const other = b.get(key);
    if (other !== undefined) dot += w * other;
  }
  for (const w of b.values()) nb += w * w;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function bridged(a: IntentView, b: IntentView): boolean {
  let shared = 0;
  for (const t of a.bag) if (b.bag.has(t)) shared += 1;
  if (shared >= BRIDGE_MIN_SHARED) return true;
  if (shared === 0) return false;
  for (const ma of a.memberBags) {
    for (const mb of b.memberBags) {
      if (jaccard(ma, mb) >= BRIDGE_TAU) return true;
    }
  }
  return false;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/* — tokens ——————————————————————————————————————————————————————————————————— */

/**
 * The SDK's `tokenize` (ratel `src/core/src/usage.rs`): lowercased alphanumeric
 * runs minus this closed-class list. Mirrored, not imported — the Rust function
 * is private. Used only for the bridge; cluster formation stays the SDK's.
 */
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "did",
  "do",
  "does",
  "for",
  "from",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "my",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "why",
  "with",
  "you",
  "your",
]);

/** A ticket or record key such as `PAAW-7`, `RC-208`, `UI-168`: letters, a dash, digits. */
const TICKET_KEY = /\b[A-Za-z]{1,6}-\d+\b/g;

/**
 * Content tokens of a member for the bridge test. Identifiers are removed first
 * (ticket keys whole, then any token carrying a digit, which covers slugs like
 * `142YXqQ9` and bare numbers), so two asks about different records can still be
 * seen to share their verb and object.
 */
export function bridgeTokens(text: string): string[] {
  return text
    .replace(TICKET_KEY, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .map((t) => t.toLowerCase())
    .filter((t) => !STOPWORDS.has(t) && !/\p{N}/u.test(t));
}

/* — ordering ———————————————————————————————————————————————————————————————— */

function bySurvivorPreference(a: IntentView, b: IntentView): number {
  return (
    b.intent.support - a.intent.support ||
    b.intent.members.length - a.intent.members.length ||
    compareIds(a.intent.id, b.intent.id)
  );
}

/** Natural order, so `intent_3` sorts before `intent_12` as the learner numbered them. */
function compareIds(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}
