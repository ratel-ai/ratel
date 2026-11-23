/**
 * Deterministic token-set (Jaccard) clustering for short query text. Agent health
 * uses it to group unserved asks into workflows (`lib/trace-signals/workflows/decide.ts`)
 * and to compare tool descriptions (`lib/trace-signals/signals/detect-siblings.ts`).
 *
 * `tokenize`/`jaccard`/`topTokens`/`labelForFreq` are ported verbatim from
 * `~/Dev/playground/test-intent-extraction/lib/intelligence/dimensions/intent/cluster.ts`,
 * which validated this exact technique (greedy single-pass token-set clustering,
 * threshold 0.3) for grouping `Search.query` text into intent clusters.
 *
 * {@link clusterQueries} accepts pre-existing buckets as seeds, so a new query can
 * merge into an established cluster, not just into other new queries from the same
 * call. Candidates that don't clear the threshold against any bucket (seeded or newly
 * spawned this call) come back as singletons. Low lexical overlap can hide a real
 * semantic match (e.g. "generate a changelog" vs. "make a changelog file", Jaccard
 * 0.25, just under threshold), so callers should treat a singleton as "unmatched
 * here", not "unique".
 *
 * Known simplification: a seed bucket starts from its `text` alone (one
 * representative phrasing), not the union of everything it has ever absorbed.
 */

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "by",
  "from",
  "is",
  "are",
  "be",
  "all",
  "get",
  "list",
  "read",
  "fetch",
  "find",
  "search",
  "show",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "as",
  "at",
  "into",
  "out",
  "up",
  "how",
  "what",
  "where",
  "which",
  "can",
  "do",
  "does",
  "use",
  "using",
  "via",
  "my",
]);

export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Token-set Jaccard similarity in [0,1]. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** The up-to-`n` most frequent tokens, by frequency then alphabetically (tie-break stable). */
export function topTokens(freq: Map<string, number>, n = 3): string[] {
  return [...freq.entries()]
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .slice(0, n)
    .map(([t]) => t);
}

/** Label = the up-to-3 most frequent content tokens; "(empty)" when there are none. */
export function labelForFreq(freq: Map<string, number>): string {
  return topTokens(freq, 3).join(" ") || "(empty)";
}

/** Merge threshold — matches the playground's calibrated default. */
export const JACCARD_THRESHOLD = 0.3;

export interface ClusterCandidate {
  /** Dedup key within this run — the candidate's normalized text. */
  key: string;
  query: string;
}

/** An existing cluster, as a seed bucket. */
export interface ClusterSeed {
  id: string;
  text: string;
}

export type ClusterAssignment =
  | { key: string; kind: "existing"; existingId: string }
  | { key: string; kind: "new"; clusterKey: string; label: string };

interface Bucket {
  existingId: string | null;
  clusterKey: string;
  tokens: Set<string>;
  freq: Map<string, number>;
}

/**
 * Greedy single-pass token-set clustering, seeded with `existing` clusters as
 * pre-existing buckets (tried before any newly spawned bucket, so established
 * clusters win ties over same-run growth). Each candidate joins the
 * highest-Jaccard bucket that clears `threshold`, else spawns a new bucket labeled
 * by its own top tokens — which later candidates in the same run can still merge
 * into. Deterministic given input order.
 */
export function clusterQueries(
  candidates: ClusterCandidate[],
  existing: ClusterSeed[],
  threshold: number = JACCARD_THRESHOLD,
): ClusterAssignment[] {
  const buckets: Bucket[] = existing.map((e) => ({
    existingId: e.id,
    clusterKey: e.id,
    tokens: new Set(tokenize(e.text)),
    freq: new Map(),
  }));
  let newSeq = 0;
  const assignments: ClusterAssignment[] = [];

  for (const c of candidates) {
    const toks = new Set(tokenize(c.query));
    let best: Bucket | undefined;
    let bestSim = 0;
    for (const b of buckets) {
      const sim = jaccard(toks, b.tokens);
      if (sim > bestSim) {
        bestSim = sim;
        best = b;
      }
    }

    let bucket: Bucket;
    if (best && bestSim >= threshold) {
      bucket = best;
    } else {
      bucket = {
        existingId: null,
        clusterKey: `new_${++newSeq}`,
        tokens: new Set(),
        freq: new Map(),
      };
      buckets.push(bucket);
    }
    for (const t of toks) {
      bucket.tokens.add(t);
      bucket.freq.set(t, (bucket.freq.get(t) ?? 0) + 1);
    }

    assignments.push(
      bucket.existingId
        ? { key: c.key, kind: "existing", existingId: bucket.existingId }
        : {
            key: c.key,
            kind: "new",
            clusterKey: bucket.clusterKey,
            label: labelForFreq(bucket.freq),
          },
    );
  }
  return assignments;
}
