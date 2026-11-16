/**
 * Which words an ask and a capability share, for showing WHY something matched.
 *
 * This is an explanation, not the ranker. Ranking runs through the SDK's own
 * index (`rank.ts`); this only has to point at the words a reader would agree
 * are "the same word" so a result row can light them up. It is deliberately
 * simple: lowercase, split names on `_`, `-` and camelCase, drop filler words,
 * and fold the common English endings so "flights" lights up "flight".
 */

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "for",
  "from",
  "get",
  "has",
  "have",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "please",
  "should",
  "so",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "this",
  "to",
  "us",
  "use",
  "want",
  "was",
  "we",
  "what",
  "when",
  "which",
  "who",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

/** The shared form of a word: "Flights" and "flight" both become "flight". */
export function stem(word: string): string {
  const lower = word.toLowerCase();
  if (lower.length > 5 && lower.endsWith("ing")) return undouble(lower.slice(0, -3));
  if (lower.length > 4 && lower.endsWith("ies")) return `${lower.slice(0, -3)}y`;
  if (lower.length > 4 && lower.endsWith("ed")) return undouble(lower.slice(0, -2));
  if (lower.length > 4 && lower.endsWith("es")) return lower.slice(0, -2);
  if (lower.length > 3 && lower.endsWith("s") && !lower.endsWith("ss")) {
    return lower.slice(0, -1);
  }
  return lower;
}

/**
 * "shipp" (from "shipping") back to "ship". Never for l, s, z or f, whose
 * doubles are usually the word itself ("call", "pass", "staff").
 */
function undouble(root: string): string {
  return /([bdgkmnprt])\1$/.test(root) ? root.slice(0, -1) : root;
}

/** Splits text into words, breaking `snake_case`, `kebab-case` and `camelCase`. */
export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

/** The stems in an ask worth matching on: no filler words, no single letters. */
export function askTerms(query: string): Set<string> {
  return new Set(
    words(query)
      .map((word) => word.toLowerCase())
      .filter((word) => word.length > 1 && !STOPWORDS.has(word))
      .map(stem),
  );
}

/**
 * The ask's words that also appear in `texts`, in the order the ask used them,
 * as the ask spelled them. Empty when nothing is shared.
 */
export function sharedWords(query: string, texts: readonly string[]): string[] {
  const present = new Set(texts.flatMap((text) => words(text).map(stem)));
  const seen = new Set<string>();
  const shared: string[] = [];
  for (const word of words(query)) {
    const lower = word.toLowerCase();
    if (lower.length <= 1 || STOPWORDS.has(lower)) continue;
    const key = stem(lower);
    if (!present.has(key) || seen.has(key)) continue;
    seen.add(key);
    shared.push(lower);
  }
  return shared;
}

export interface Segment {
  text: string;
  match: boolean;
}

/**
 * `text` cut into runs, each marked when it is one of `terms`. Joining the
 * runs gives back `text` exactly, so a renderer never drops a character.
 */
export function highlight(text: string, terms: ReadonlySet<string>): Segment[] {
  if (terms.size === 0 || text === "") return text === "" ? [] : [{ text, match: false }];
  const segments: Segment[] = [];
  const pattern = /[\p{L}\p{N}]+/gu;
  let cursor = 0;
  for (const found of text.matchAll(pattern)) {
    const start = found.index ?? 0;
    const word = found[0];
    // A name like `book_flight` is one run of letters per part already, but a
    // camelCase name is not: test each of its parts, and light the whole run
    // when any part matches, which is how a reader sees the name anyway.
    const hit = words(word).some((part) => terms.has(stem(part)));
    if (!hit) continue;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
    segments.push({ text: word, match: true });
    cursor = start + word.length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}
