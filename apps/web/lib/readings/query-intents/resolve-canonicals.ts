import type {
  CanonicalAssignment,
  ClusterCandidate,
  Clusterer,
} from "@/lib/readings/query-intents/clusterer";

/** An existing canonical ask, as read for matching (exact or fuzzy). */
export interface CanonicalRow {
  id: string;
  normalizedText: string;
  text: string;
  memberText?: string;
}

export interface ResolveCanonicalsDeps {
  /** Exact-match lookup: the canonicals whose `normalizedText` is one of the given
   * keys. Must be EXHAUSTIVE (uncapped) — a literal repeat has to find its canonical
   * however many the project has. */
  lookupExactCanonicals: (projectId: string, normalizedTexts: string[]) => Promise<CanonicalRow[]>;
  /** The fuzzy-clustering seeds (may be capped). Only called when something is left
   * after exact match. */
  listExistingCanonicals: (projectId: string) => Promise<CanonicalRow[]>;
  clusterer: Clusterer;
}

/**
 * Resolve each distinct phrase to the canonical ask it belongs to — the two passes
 * every intent goes through, lifted out of the categorize pipeline so the analyze
 * API can run the SAME resolution and its intents join the same clusters:
 *
 *   1. exact match on the normalized key (cheap, exhaustive);
 *   2. the pluggable {@link Clusterer} for everything fuzzier, seeded with the
 *      project's existing canonicals. A candidate that matches nothing stands as
 *      its own canonical, so nothing is ever dropped.
 *
 * Input is deduped by `key` (the normalized text): the clusterer sees each distinct
 * phrasing once. Returns one assignment per distinct key.
 */
export async function resolveCanonicals(
  projectId: string,
  candidates: readonly ClusterCandidate[],
  deps: ResolveCanonicalsDeps,
): Promise<Map<string, CanonicalAssignment>> {
  const out = new Map<string, CanonicalAssignment>();
  if (candidates.length === 0) return out;

  const firstByKey = new Map<string, ClusterCandidate>();
  for (const c of candidates) if (!firstByKey.has(c.key)) firstByKey.set(c.key, c);

  const exact = await deps.lookupExactCanonicals(projectId, [...firstByKey.keys()]);
  const exactByKey = new Map(exact.map((e) => [e.normalizedText, e]));

  const remaining: ClusterCandidate[] = [];
  for (const [key, c] of firstByKey) {
    const match = exactByKey.get(key);
    if (match) out.set(key, { normalizedText: match.normalizedText, canonicalText: match.text });
    else remaining.push(c);
  }
  if (remaining.length === 0) return out;

  const existing = await deps.listExistingCanonicals(projectId);
  const clustered = await deps.clusterer.cluster(remaining, existing);
  for (const c of remaining) {
    const assignment = clustered.get(c.key);
    // The clusterer contract guarantees an assignment per candidate; fall back to
    // self-canonical defensively so an occurrence is never lost.
    out.set(c.key, assignment ?? { normalizedText: c.key, canonicalText: c.text });
  }
  return out;
}
