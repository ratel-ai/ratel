import { normalizeIntent } from "@/lib/readings/query-intents/normalize";
import { type ClusterSeed, clusterQueries } from "@/lib/readings/text/cluster";

/**
 * The fuzzy-clustering seam — the swappable strategy that groups near-duplicate asks
 * into one canonical. The pipeline handles extraction + exact-match; everything fuzzier
 * than a literal repeat is delegated here, so the clustering method can be replaced
 * (a different algorithm, an embedding model, a future service) WITHOUT touching the
 * pipeline. {@link JaccardClusterer} is the default, deterministic, offline impl.
 */
export interface Clusterer {
  /**
   * Resolve each candidate to the canonical ask it belongs to. `candidates` are the
   * batch's distinct new phrasings (the pipeline has already exact-matched literal
   * repeats out); `existing` are the project's known canonicals, used as merge targets.
   * Returns a map keyed by `candidate.key`. Async so a model/service-backed clusterer
   * can do IO — the default resolves synchronously.
   */
  cluster(
    candidates: ClusterCandidate[],
    existing: ClusterCanonical[],
  ): Promise<Map<string, CanonicalAssignment>>;
}

/** A new phrasing to resolve: a stable `key` (its normalized text) + the display `text`. */
export interface ClusterCandidate {
  key: string;
  text: string;
}

/** An existing canonical ask, offered as a merge target. */
export interface ClusterCanonical {
  id: string;
  normalizedText: string;
  text: string;
  /** The cluster's accumulated member phrases (`query_intents.member_text`),
   * newline-joined. Read by the BM25 clusterer; the Jaccard clusterer ignores it. */
  memberText?: string;
}

/** The canonical an occurrence resolves to. */
export interface CanonicalAssignment {
  normalizedText: string;
  canonicalText: string;
}

/**
 * The default clusterer: token-set **Jaccard** similarity (`./cluster.ts`) seeded with
 * the project's existing canonicals. A candidate merges into an existing canonical — or
 * into a same-run cluster of ≥2 candidates — when their word-set overlap ≥
 * `JACCARD_THRESHOLD`; otherwise it stands as its own canonical (never dropped).
 * Deterministic, offline, needs no API key.
 */
export class JaccardClusterer implements Clusterer {
  async cluster(
    candidates: ClusterCandidate[],
    existing: ClusterCanonical[],
  ): Promise<Map<string, CanonicalAssignment>> {
    const out = new Map<string, CanonicalAssignment>();
    if (candidates.length === 0) return out;

    const seeds: ClusterSeed[] = existing.map((c) => ({ id: c.id, text: c.text }));
    const assignments = clusterQueries(
      candidates.map((c) => ({ key: c.key, query: c.text })),
      seeds,
    );

    const existingById = new Map(existing.map((c) => [c.id, c]));
    const textByKey = new Map(candidates.map((c) => [c.key, c.text]));
    const membersByClusterKey = new Map<string, string[]>();
    for (const a of assignments) {
      if (a.kind !== "new") continue;
      const arr = membersByClusterKey.get(a.clusterKey) ?? [];
      arr.push(a.key);
      membersByClusterKey.set(a.clusterKey, arr);
    }

    for (const a of assignments) {
      if (a.kind === "existing") {
        const ex = existingById.get(a.existingId)!;
        out.set(a.key, { normalizedText: ex.normalizedText, canonicalText: ex.text });
        continue;
      }
      // A genuine same-run cluster (≥2 members) canonicalizes to the first member's
      // text; a lone member stands as its own canonical.
      const members = membersByClusterKey.get(a.clusterKey)!;
      const canonicalText =
        members.length >= 2 ? textByKey.get(members[0])! : textByKey.get(a.key)!;
      out.set(a.key, { normalizedText: normalizeIntent(canonicalText), canonicalText });
    }
    return out;
  }
}

/** The process-wide default clusterer (swap this in the jobs wiring to change strategy). */
export const jaccardClusterer: Clusterer = new JaccardClusterer();
