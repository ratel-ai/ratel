/**
 * Score arithmetic for the Playground's three ranking modes. Pure and
 * dependency-free so the blend the UI explains is the blend that ran.
 *
 * BM25 and cosine are not on the same scale: BM25 is unbounded and corpus
 * relative, cosine is in [-1, 1]. So `hybrid` normalizes each side WITHIN its
 * bucket before mixing. Normalizing per bucket (not globally) keeps the skills
 * and tools rankings independent, matching how the SDK's discovery ranks them.
 */

/** Cosine similarity of two equal-length vectors; 0 when either has no norm. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Scale a bucket's scores into [0, 1] by its own min and max. A bucket whose
 * scores are all equal (including all-zero, i.e. nothing matched) maps to 0
 * rather than 1, because "everything tied" must not read as "everything perfect".
 */
export function normalizeWithinBucket(scores: ReadonlyMap<string, number>): Map<string, number> {
  const values = [...scores.values()];
  if (values.length === 0) return new Map();
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const normalized = new Map<string, number>();
  for (const [id, score] of scores) {
    normalized.set(id, span === 0 ? 0 : (score - min) / span);
  }
  return normalized;
}

/** Clamp the semantic share of a hybrid blend into [0, 1]. */
export function clampWeight(weight: number): number {
  if (!Number.isFinite(weight)) return 0;
  return Math.min(1, Math.max(0, weight));
}

/**
 * The band Hybrid's mix is offered in, as a BM25 percentage.
 *
 * Hybrid is a blend. At 0% it is exactly the Embeddings mode and at 100% it is
 * exactly BM25, both of which have their own button, so those ends are two
 * ways to reach a place you can already get to, sitting where a reader expects
 * a mix. Keeping the slider inside the band means every hybrid run really does
 * combine the two.
 *
 * Scoring itself stays permissive: `blendScores` handles 0 and 1 correctly, and
 * the route keeps accepting them. This is the range the control offers, not a
 * rule about what the maths can express.
 */
export const HYBRID_MIN_SHARE = 5;
export const HYBRID_MAX_SHARE = 95;

/** Snap a BM25 share into the hybrid band. */
export function clampHybridShare(share: number): number {
  if (!Number.isFinite(share)) return 50;
  return Math.min(HYBRID_MAX_SHARE, Math.max(HYBRID_MIN_SHARE, share));
}

/**
 * Mix normalized lexical and semantic scores. `weight` is the semantic share:
 * 0 reproduces pure lexical, 1 reproduces pure semantic.
 */
export function blendScores(
  lexical: ReadonlyMap<string, number>,
  semantic: ReadonlyMap<string, number>,
  weight: number,
): Map<string, number> {
  const share = clampWeight(weight);
  const ids = new Set([...lexical.keys(), ...semantic.keys()]);
  const blended = new Map<string, number>();
  for (const id of ids) {
    blended.set(id, (1 - share) * (lexical.get(id) ?? 0) + share * (semantic.get(id) ?? 0));
  }
  return blended;
}

/**
 * Order ids by score, highest first, breaking ties by id so a run is stable
 * across repeats: a jittering tie would read as a ranking change in the diff.
 */
export function rankIds(scores: ReadonlyMap<string, number>): string[] {
  return [...scores.entries()]
    .sort(([idA, scoreA], [idB, scoreB]) =>
      scoreB === scoreA ? idA.localeCompare(idB) : scoreB - scoreA,
    )
    .map(([id]) => id);
}
