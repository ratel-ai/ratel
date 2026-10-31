import { normalizeIntent } from "@/lib/readings/query-intents/normalize";

/**
 * A cluster's accumulated vocabulary (`query_intents.member_text`): the distinct,
 * cleaned intent phrases a canonical has absorbed, newline-joined, most recent last.
 *
 * The BM25 clusterer indexes a cluster as ONE document built from its canonical text
 * plus this list, so a paraphrase that shares words with any earlier member — not just
 * the representative phrase — finds the cluster. Bounded so the document never grows
 * without limit: the oldest phrases fall off first. Never read for exact-match, so it
 * carries no dedup semantics and a lost concurrent write is harmless.
 */

/** Most phrases kept per canonical. */
export const MEMBER_TEXT_MAX_PHRASES = 25;
/** Hard byte-ish bound on the joined text (chars), applied after the phrase cap. */
export const MEMBER_TEXT_MAX_CHARS = 4000;

export function splitMemberText(memberText: string): string[] {
  return memberText
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Merge `phrases` into `existing`, deduped by normalized form and excluding the
 * canonical's own text (`canonicalNormalized`) — that phrase is already the
 * document's head. Idempotent: merging the same batch twice yields the same text.
 * Returns `existing` unchanged when nothing new arrived.
 */
export function mergeMemberText(
  existing: string,
  phrases: readonly string[],
  canonicalNormalized?: string,
): string {
  const kept: string[] = [];
  const seen = new Set<string>();
  if (canonicalNormalized) seen.add(canonicalNormalized);

  for (const p of [...splitMemberText(existing), ...phrases]) {
    const text = p.trim();
    if (!text) continue;
    const norm = normalizeIntent(text);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    kept.push(text);
  }

  // Newest last; drop from the front when over the phrase cap.
  let out = kept.slice(Math.max(0, kept.length - MEMBER_TEXT_MAX_PHRASES));
  // Then the char cap, again from the front.
  while (out.length > 0 && out.join("\n").length > MEMBER_TEXT_MAX_CHARS) out = out.slice(1);
  return out.join("\n");
}
