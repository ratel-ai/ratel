/**
 * Normalized BM25 relevance for intent → skill coverage.
 *
 * The SDK's native ranker returns a raw BM25 score: unbounded, corpus-relative,
 * and — for coverage — misleading, because ONE shared word ("request" in
 * "review-pull-request", "codebase" in "search-codebase") already clears any
 * floor near zero. The question coverage actually asks is "how much of what the
 * user asked for does this skill talk about?", which is the matched share of the
 * query's own IDF mass:
 *
 *     score(d, q) = Σ over matched terms t of
 *                   idf(t) · tf·(k1+1) / (tf + k1·(1 − b + b·dl/avgdl))
 *     relevance   = score / Σ over DISTINCT query terms of idf(t), clamped to [0, 1]
 *
 * A term the corpus never saw still counts in the denominator (with the maximum
 * idf a term can have), so "cancel subscription" against "list subscription plans"
 * scores the subscription half only — well under a sensible threshold — instead
 * of reading as covered. The SDK does not expose idf, so this is a small, pure
 * BM25 of our own over the skill texts; it is deliberately NOT what the agent
 * retrieves with (that stays `@ratel-ai/sdk`, see `lib/suggestions/retrievability.ts`).
 * This one only judges coverage.
 */

/** Okapi BM25 constants. `k1` saturates term frequency; `b` scales length normalization. */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/**
 * Function words that carry no topical signal. Deliberately a small, grammatical
 * set — verbs like "search", "list", "get" stay, because a skill named
 * "search-codebase" is ABOUT searching and dropping the verb would hide that.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
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
  "was",
  "were",
  "been",
  "being",
  "am",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "there",
  "here",
  "as",
  "at",
  "into",
  "out",
  "up",
  "if",
  "then",
  "than",
  "so",
  "not",
  "no",
  "i",
  "me",
  "my",
  "we",
  "us",
  "our",
  "you",
  "your",
  "they",
  "them",
  "their",
  "he",
  "she",
  "his",
  "her",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "can",
  "could",
  "would",
  "should",
  "will",
  "may",
  "might",
  "know",
  "want",
  "wants",
  "need",
  "needs",
  "like",
  "please",
  "also",
  "any",
  "some",
  "all",
  "how",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
]);

/**
 * Conservative suffix stripping so "commits"/"commit", "refunded"/"refund",
 * "deploying"/"deploy" fold together. Not a full Porter stemmer: it only strips
 * when enough stem remains, which is the failure mode that matters here
 * ("status" → "statu" would be wrong, so a trailing lone "s" is left on short
 * words and on words ending in "ss"/"us"/"is").
 */
export function stem(token: string): string {
  let t = token;
  // "deployments"/"deployment" → "deploy"; "-ments" first so the plural does not
  // fall through to the bare "-s" rule and leave "deployment" intact.
  if (t.length > 7 && t.endsWith("ments")) t = t.slice(0, -5);
  else if (t.length > 6 && t.endsWith("ment")) t = t.slice(0, -4);
  else if (t.length > 5 && t.endsWith("ing")) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith("ed")) t = t.slice(0, -2);
  else if (t.length > 4 && t.endsWith("ies")) t = t.slice(0, -3) + "y";
  // "-es" is a plural suffix only after a sibilant ("patches", "boxes", "classes");
  // elsewhere the "e" belongs to the stem ("usages" → "usage", "changes" → "change").
  else if (t.length > 4 && /(ss|x|z|ch|sh)es$/.test(t)) t = t.slice(0, -2);
  else if (
    t.length > 3 &&
    t.endsWith("s") &&
    !t.endsWith("ss") &&
    !t.endsWith("us") &&
    !t.endsWith("is")
  ) {
    t = t.slice(0, -1);
  }
  return t;
}

/** Lowercase, split on anything non-alphanumeric (so "search-codebase" is two
 * terms), drop single characters and function words, stem the rest. */
export function tokenizeForRelevance(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map(stem);
}

/** The raw (pre-lowercase) identifier-looking words of `text`, as the stemmed tokens
 * the index will see — used to decide which query terms get the capped idf. */
export function identifierTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.normalize("NFKC").split(/[^A-Za-z0-9_.]+/)) {
    // Sentence punctuation is not an identifier marker: "order." is the word "order",
    // while "fetch.retry" keeps its interior dot.
    const word = raw.replace(/^\.+|\.+$/g, "");
    if (!word || !looksLikeIdentifier(word)) continue;
    for (const t of tokenizeForRelevance(word)) out.add(t);
  }
  return out;
}

export interface RelevanceDocument {
  id: string;
  text: string;
}

export interface RelevanceHit {
  id: string;
  /** Raw BM25 score — kept for diagnostics; not comparable across catalogs. */
  score: number;
  /** `score / Σ idf(query terms)`, clamped to [0, 1]. Comparable across catalogs. */
  relevance: number;
}

interface IndexedDocument {
  id: string;
  length: number;
  tf: Map<string, number>;
}

/**
 * A token that reads as a code identifier: camelCase, snake_case, dotted, or with
 * digits (`fetchWithTimeout`, `max_tokens`, `v2`). The tokenizer lowercases before
 * this runs, so the check is on the RAW token. Such tokens name the thing the user
 * is working on, never what a skill does, and would otherwise carry the largest idf
 * in the index (unseen ⇒ maximal). {@link buildRelevanceIndex} caps their idf at
 * the average of the seen terms so an ask with an identifier in it can still be
 * covered by the skill that does the operation.
 */
export function looksLikeIdentifier(rawToken: string): boolean {
  return /[a-z][A-Z]|_|\.|\d/.test(rawToken);
}

export interface RelevanceIndex {
  readonly size: number;
  /** Rank every document for `query`, best first. Empty when the query has no terms. */
  search(query: string, topK?: number): RelevanceHit[];
  /** Relevance of `query` against an AD-HOC document (not in the index), scored with
   * this index's idf and average length. Lets a caller compare two short phrases in
   * either direction without indexing every phrase as its own document. */
  relevanceBetween(query: string, docText: string): number;
  /** Exposed for tests and calibration: the idf a term carries in this index. */
  idf(term: string): number;
  /** A query tokenized once, for scoring against many prepared documents. Null when it has no terms. */
  prepareQuery(query: string): PreparedQuery | null;
  /** An ad-hoc document tokenized once (not added to the index). */
  prepareDocument(text: string): PreparedDocument;
  /** {@link relevanceBetween} over already-prepared sides: the same score, no re-tokenizing. */
  relevanceOf(query: PreparedQuery, doc: PreparedDocument): number;
}

/** A query's distinct terms and the idf mass they carry, as one index scores them. */
export interface PreparedQuery {
  readonly terms: readonly string[];
  readonly idfMass: number;
}

/** A document's term frequencies and length. */
export interface PreparedDocument {
  readonly length: number;
  readonly tf: ReadonlyMap<string, number>;
}

/** Build an in-memory BM25 index over `documents`. Cheap: a project has hundreds
 * of skills at most, so this is rebuilt per catalog version, never persisted. */
export function buildRelevanceIndex(
  documents: readonly RelevanceDocument[],
  opts: { k1?: number; b?: number; tokenize?: (text: string) => string[] } = {},
): RelevanceIndex {
  const k1 = opts.k1 ?? BM25_K1;
  const b = opts.b ?? BM25_B;
  // Injectable so a caller can layer a synonym map (or a domain tokenizer) on top of
  // the default without forking the index; documents and queries MUST share it.
  const tokenize = opts.tokenize ?? tokenizeForRelevance;

  const indexDocument = (id: string, text: string): IndexedDocument => {
    const terms = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { id, length: terms.length, tf };
  };

  const docs: IndexedDocument[] = [];
  const df = new Map<string, number>();
  let totalLength = 0;
  for (const d of documents) {
    const doc = indexDocument(d.id, d.text);
    for (const t of doc.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    docs.push(doc);
    totalLength += doc.length;
  }
  const n = docs.length;
  const avgdl = n === 0 ? 0 : totalLength / n;

  // Standard BM25 idf. A term no document contains gets df = 0 — the LARGEST idf
  // in the index — so an unmatched query term costs the most in the denominator.
  const idf = (term: string): number => {
    const d = df.get(term) ?? 0;
    return Math.log(1 + (n - d + 0.5) / (d + 0.5));
  };
  // The idf a code identifier in a QUERY is allowed to carry: the mean idf of the
  // terms the corpus actually contains (see looksLikeIdentifier). Unseen otherwise.
  let seenIdfTotal = 0;
  for (const term of df.keys()) seenIdfTotal += idf(term);
  const identifierIdfCap = df.size === 0 ? 0 : seenIdfTotal / df.size;
  const queryIdf = (term: string, identifiers: Set<string>): number =>
    identifiers.has(term) && !df.has(term) ? Math.min(idf(term), identifierIdfCap) : idf(term);

  // The query side, shared by both entry points: distinct terms and the idf mass
  // they carry (identifier-capped). null when there is nothing to score.
  const prepareQuery = (query: string): PreparedQuery | null => {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return null;
    const identifiers = identifierTokens(query);
    let idfMass = 0;
    for (const t of terms) idfMass += queryIdf(t, identifiers);
    return idfMass <= 0 ? null : { terms, idfMass };
  };

  // The ONE scoring path: raw BM25 and its normalized relevance.
  const scoreDoc = (
    q: PreparedQuery,
    doc: PreparedDocument,
  ): { score: number; relevance: number } => {
    let score = 0;
    const lengthNorm = 1 - b + b * (avgdl === 0 ? 0 : doc.length / avgdl);
    for (const t of q.terms) {
      const tf = doc.tf.get(t);
      if (!tf) continue;
      score += idf(t) * ((tf * (k1 + 1)) / (tf + k1 * lengthNorm));
    }
    return { score, relevance: score <= 0 ? 0 : Math.min(1, Math.max(0, score / q.idfMass)) };
  };

  return {
    size: n,
    idf,
    prepareQuery,
    prepareDocument: (text) => indexDocument("", text),
    relevanceOf: (q, doc) => scoreDoc(q, doc).relevance,
    relevanceBetween(query, docText) {
      const q = prepareQuery(query);
      if (!q) return 0;
      return scoreDoc(q, indexDocument("", docText)).relevance;
    },
    search(query, topK = n) {
      if (n === 0) return [];
      const q = prepareQuery(query);
      if (!q) return [];
      const hits: RelevanceHit[] = [];
      for (const doc of docs) {
        const { score, relevance } = scoreDoc(q, doc);
        if (score <= 0) continue;
        hits.push({ id: doc.id, score, relevance });
      }
      hits.sort(
        (x, y) => y.relevance - x.relevance || y.score - x.score || x.id.localeCompare(y.id),
      );
      return hits.slice(0, topK);
    },
  };
}
