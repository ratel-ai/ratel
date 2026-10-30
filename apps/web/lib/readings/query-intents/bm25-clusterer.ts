import { envNumber } from "@/lib/platform/env-number";
import type {
  CanonicalAssignment,
  ClusterCandidate,
  ClusterCanonical,
  Clusterer,
} from "@/lib/readings/query-intents/clusterer";
import { stripTrailingContext } from "@/lib/readings/query-intents/intent-text";
import { splitMemberText } from "@/lib/readings/query-intents/member-text";
import { normalizeIntent } from "@/lib/readings/query-intents/normalize";
import { buildRelevanceIndex, tokenizeForRelevance } from "@/lib/readings/query-intents/relevance";

/**
 * Lexical clustering by symmetric normalized BM25 relevance: what the
 * categorize job clusters with, in place of {@link JaccardClusterer}.
 *
 * Why not Jaccard: it weighs every token the same ("their" as much as "refund"), has
 * no stemming, treats verbs like "search" as stopwords, and seeds each bucket from
 * the canonical text alone — so the same ask phrased three ways by the extractor lands
 * in three clusters. Here:
 *
 *   - a cluster is ONE document: its canonical text plus every member phrase it has
 *     absorbed (`member_text`), so later paraphrases match on the whole vocabulary;
 *   - similarity is the best SYMMETRIC match against any single phrase of the cluster:
 *     `max over phrases p of min(rel(candidate → p), rel(p → candidate))`, where `rel`
 *     is the matched share of the query's IDF mass in [0, 1] (`./relevance.ts`). The
 *     reverse direction stops a two-word phrase from joining a long phrase that merely
 *     contains its words; scoring per phrase (not against the union document) keeps a
 *     cluster's accumulated vocabulary from covering everything. Clusters are shortlisted
 *     by SHARED TOKEN (an inverted map over every absorbed phrase), never by a score over
 *     the union document: BM25 length normalization makes a long union score far below
 *     the phrase inside it, so a union-score prefilter silently dropped rare members of
 *     large clusters. The union document is still indexed, but only so that idf and
 *     average length — and therefore every score — are unchanged;
 *   - a trailing context clause ("… after the requested refund is processed") is
 *     stripped from the working copy so provenance words don't drag the phrase into
 *     the other ask's cluster. The stored/dedup text is never changed;
 *   - greedy single pass, deterministic in input order, same-run buckets can grow.
 *     Equal scores go to the earlier seed (the seeds arrive ordered by occurrences, then
 *     recency), then to the earlier same-run cluster — never to a doc-id string order.
 *
 * Ambiguity: when the top two buckets both clear the threshold and sit within
 * `margin` of each other, the candidate stays its own canonical rather than guessing.
 * There is no re-cluster pass yet; a later run can still absorb it because the
 * phrase is by then in some cluster's member document.
 *
 * Known non-merge: pure synonyms ("stop billing" vs "cancel their plan") share no stem
 * and score 0. The only lexical lever is the optional {@link SynonymMap}.
 */

/** Merge when the symmetric relevance is at least this. Env `RATEL_INTENT_BM25_THRESHOLD`. */
export const BM25_CLUSTER_THRESHOLD = 0.6;
/** Ambiguity band: two buckets over threshold and closer than this ⇒ singleton. Env
 * `RATEL_INTENT_BM25_MARGIN`. */
export const BM25_CLUSTER_MARGIN = 0.1;

/** Stemmed token → canonical stemmed token ("subscription" → "plan"). Applied to
 * documents and queries alike. Empty by default; no map ships with the product. */
export type SynonymMap = ReadonlyMap<string, string>;

export interface ClusterRunSummary {
  candidates: number;
  seeds: number;
  mergedExisting: number;
  mergedSameRun: number;
  singletons: number;
  ambiguous: number;
  durationMs: number;
}

export interface Bm25ClustererOptions {
  threshold?: number;
  margin?: number;
  synonyms?: SynonymMap;
  onSummary?: (summary: ClusterRunSummary) => void;
}

interface Bucket {
  /** `ex:<id>` for an existing canonical, `c:<key>` for a same-run cluster. */
  docId: string;
  /** Tie-break order: seeds by their input position, then same-run buckets by creation. */
  rank: number;
  existing: ClusterCanonical | null;
  /** The display text a same-run bucket canonicalizes to: its first member's ORIGINAL text. */
  headText: string;
  /** Every phrase the cluster is scored on (provenance clauses stripped): the canonical
   * text, the stored members, and same-run members as they join. */
  phrases: string[];
}

export class Bm25Clusterer implements Clusterer {
  private readonly threshold: number;
  private readonly margin: number;
  private readonly synonyms: SynonymMap;
  private readonly onSummary?: (summary: ClusterRunSummary) => void;

  constructor(opts: Bm25ClustererOptions = {}) {
    this.threshold = opts.threshold ?? BM25_CLUSTER_THRESHOLD;
    this.margin = opts.margin ?? BM25_CLUSTER_MARGIN;
    this.synonyms = opts.synonyms ?? new Map();
    this.onSummary = opts.onSummary;
  }

  private tokenize = (text: string): string[] =>
    tokenizeForRelevance(text).map((t) => this.synonyms.get(t) ?? t);

  async cluster(
    candidates: ClusterCandidate[],
    existing: ClusterCanonical[],
  ): Promise<Map<string, CanonicalAssignment>> {
    const started = Date.now();
    const out = new Map<string, CanonicalAssignment>();
    const summary: ClusterRunSummary = {
      candidates: candidates.length,
      seeds: existing.length,
      mergedExisting: 0,
      mergedSameRun: 0,
      singletons: 0,
      ambiguous: 0,
      durationMs: 0,
    };
    if (candidates.length === 0) {
      this.finish(summary, started);
      return out;
    }

    // Working copies: provenance clauses stripped for scoring only.
    const workingText = new Map(candidates.map((c) => [c.key, stripTrailingContext(c.text)]));
    const originalText = new Map(candidates.map((c) => [c.key, c.text]));

    // One index over every existing cluster document and every candidate. Candidate
    // docs serve the reverse direction (cluster head → candidate) and let same-run
    // buckets be scored against their members.
    const docs = [
      ...existing.map((e) => ({ id: `ex:${e.id}`, text: clusterDocument(e) })),
      ...candidates.map((c) => ({ id: `c:${c.key}`, text: workingText.get(c.key)! })),
    ];
    const index = buildRelevanceIndex(docs, { tokenize: this.tokenize });

    const buckets: Bucket[] = existing.map((e, rank) => ({
      docId: `ex:${e.id}`,
      rank,
      existing: e,
      headText: e.text,
      phrases: clusterPhrases(e).map(stripTrailingContext),
    }));
    // Shortlist index: token → buckets holding a phrase with that token. A phrase that
    // shares no token with a candidate has forward relevance 0, so this can never
    // exclude a bucket the per-phrase scoring would accept. Same-run buckets and newly
    // absorbed phrases are posted as they appear, so later candidates see them.
    const postings = new Map<string, Set<Bucket>>();
    const post = (bucket: Bucket, phrase: string) => {
      for (const token of this.tokenize(phrase)) {
        let set = postings.get(token);
        if (!set) postings.set(token, (set = new Set()));
        set.add(bucket);
      }
    };
    for (const bucket of buckets) for (const phrase of bucket.phrases) post(bucket, phrase);
    let nextRank = buckets.length;

    for (const c of candidates) {
      const text = workingText.get(c.key)!;
      const ownDoc = `c:${c.key}`;

      // Shortlist: every bucket that shares at least one token with the candidate.
      const shortlist = new Set<Bucket>();
      for (const token of this.tokenize(text)) {
        const set = postings.get(token);
        if (set) for (const bucket of set) shortlist.add(bucket);
      }

      // Symmetric, per phrase: the best min(candidate → phrase, phrase → candidate)
      // over the bucket's phrases. "Does this candidate closely restate ANY member?"
      const scored: Array<{ bucket: Bucket; score: number }> = [];
      for (const bucket of shortlist) {
        let best = 0;
        for (const phrase of bucket.phrases) {
          const fwd = index.relevanceBetween(text, phrase);
          if (fwd < this.threshold || fwd <= best) continue;
          const sym = Math.min(fwd, index.relevanceBetween(phrase, text));
          if (sym > best) best = sym;
        }
        if (best > 0) scored.push({ bucket, score: best });
      }
      scored.sort((x, y) => y.score - x.score || x.bucket.rank - y.bucket.rank);

      const best = scored[0];
      const second = scored[1];
      if (best && best.score >= this.threshold) {
        const ambiguous =
          second !== undefined &&
          second.score >= this.threshold &&
          best.score - second.score < this.margin;
        if (!ambiguous) {
          const bucket = best.bucket;
          bucket.phrases.push(text);
          post(bucket, text);
          if (bucket.existing) {
            summary.mergedExisting++;
            out.set(c.key, {
              normalizedText: bucket.existing.normalizedText,
              canonicalText: bucket.existing.text,
            });
          } else {
            summary.mergedSameRun++;
            out.set(c.key, {
              normalizedText: normalizeIntent(bucket.headText),
              canonicalText: bucket.headText,
            });
          }
          continue;
        }
        summary.ambiguous++;
      }

      // New bucket, headed by this candidate's ORIGINAL (unstripped) text.
      const head = originalText.get(c.key)!;
      const bucket: Bucket = {
        docId: ownDoc,
        rank: nextRank++,
        existing: null,
        headText: head,
        phrases: [text],
      };
      post(bucket, text);
      summary.singletons++;
      out.set(c.key, { normalizedText: normalizeIntent(head), canonicalText: head });
    }

    this.finish(summary, started);
    return out;
  }

  private finish(summary: ClusterRunSummary, started: number) {
    summary.durationMs = Date.now() - started;
    this.onSummary?.(summary);
  }
}

/** An existing cluster's phrases: canonical text first, then its stored members. */
function clusterPhrases(e: ClusterCanonical): string[] {
  return [e.text, ...(e.memberText ? splitMemberText(e.memberText) : [])];
}

/** An existing cluster as one union document — the prefilter's upper bound. */
function clusterDocument(e: ClusterCanonical): string {
  return clusterPhrases(e).join("\n");
}

/** A clusterer tuned from env (`RATEL_INTENT_BM25_THRESHOLD`, `RATEL_INTENT_BM25_MARGIN`),
 * the jobs-wiring entry point. */
const unitInterval = (n: number) => n >= 0 && n <= 1;

export function bm25ClustererFromEnv(
  opts: Pick<Bm25ClustererOptions, "onSummary" | "synonyms"> = {},
): Bm25Clusterer {
  return new Bm25Clusterer({
    threshold: envNumber("RATEL_INTENT_BM25_THRESHOLD", BM25_CLUSTER_THRESHOLD, unitInterval),
    margin: envNumber("RATEL_INTENT_BM25_MARGIN", BM25_CLUSTER_MARGIN, unitInterval),
    ...opts,
  });
}
