import type { ClusterIndex, MatchThresholds } from "@/lib/readings/intent-engine/match";
import { DEFAULT_THRESHOLDS } from "@/lib/readings/intent-engine/match";
import { ANAPHOR, ARTICLES, type VerbLexicon } from "@/lib/readings/intent-engine/text";

/**
 * Split an ask that holds two requests ("check the CI tests and fix the failed
 * ones") into its parts, by rules alone, and only when the split is confirmed.
 *
 * A cut is proposed at a coordinator (`;`, "and", "then", "also", "after
 * that") only where both sides open with an action verb, so "search and
 * replace in the config" or "compare A and B" are never cut. A later part that
 * points back ("the failed ones", "it", "them") borrows the object of the part
 * before it. The split is kept only if every part joins a DIFFERENT existing
 * cluster; otherwise the ask stays whole, and a first-time pair of requests is
 * split once its parts have been asked on their own.
 */

export interface AskPart {
  text: string;
  /** True when the text was rewritten (an object carried over): match on it, never store it. */
  synthetic: boolean;
}

const CUT =
  /\s*(?:;|,?\s+and\s+then\s+|,?\s+and\s+also\s+|,?\s+after\s+that,?\s+|,?\s+then\s+|,?\s+also\s+|,?\s+and\s+)\s*/i;

export { ANAPHOR };

const MAX_PARTS = 4;

/** Clauses of `text` at verb-led coordinators, objects carried over. One clause means no cut. */
export function proposeParts(text: string, verbs: VerbLexicon): AskPart[] {
  const pieces = text
    .split(CUT)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (pieces.length < 2) return [{ text, synthetic: false }];
  // Glue back any piece that does not open with a verb: it was not a second request.
  const clauses: string[] = [];
  for (const piece of pieces) {
    if (clauses.length > 0 && !verbs.startsWithVerb(piece))
      clauses[clauses.length - 1] += ` and ${piece}`;
    else clauses.push(piece);
  }
  if (clauses.length < 2 || !verbs.startsWithVerb(clauses[0]) || clauses.length > MAX_PARTS) {
    return [{ text, synthetic: false }];
  }
  const parts: AskPart[] = [];
  let previousObject = "";
  for (const clause of clauses) {
    const words = clause.split(/\s+/);
    // The object as a bare phrase: "the CI tests" carries over as "CI tests", so
    // "fix the failed ones" reads "fix the failed CI tests".
    const object = words.slice(1).join(" ").replace(ARTICLES, "");
    if (previousObject && ANAPHOR.test(clause)) {
      parts.push({ text: clause.replace(ANAPHOR, previousObject), synthetic: true });
    } else {
      parts.push({ text: clause, synthetic: false });
      previousObject = object;
    }
  }
  return parts;
}

/**
 * The confirmed split of an ask, or null to keep it whole. `capabilities` is
 * what the ask's turn ran; it is the tool witness for each part's match.
 */
export function splitAsk(
  text: string,
  verbs: VerbLexicon,
  index: ClusterIndex,
  capabilities: ReadonlySet<string>,
  thresholds: MatchThresholds = DEFAULT_THRESHOLDS,
): Array<AskPart & { key: string }> | null {
  const parts = proposeParts(text, verbs);
  if (parts.length < 2) return null;
  const out: Array<AskPart & { key: string }> = [];
  const keys = new Set<string>();
  for (const part of parts) {
    // A part restates a cluster, or (a part with a qualifier: "fix the failed CI
    // tests") wholly contains exactly one cluster's wording.
    const result = index.match(part.text, capabilities, thresholds);
    let key = result.kind === "join" ? result.key : null;
    if (key === null) {
      const holds = index.containedIn(part.text, thresholds.strong);
      if (holds.length === 1) key = holds[0];
    }
    if (key === null || keys.has(key)) return null;
    keys.add(key);
    out.push({ ...part, key });
  }
  return out;
}
