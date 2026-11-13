/**
 * Normalize an extracted intent's text into a stable **dedup key** for the
 * cumulative "recurring asks" view (`project_intents.normalized_text`).
 *
 * Two intents that mean the same thing modulo case, spacing, and trailing sentence
 * punctuation fold to one row whose `occurrences` we increment. This is deliberately
 * cheap **exact-normalized** grouping — true semantic clustering (wording that
 * differs but means the same) is a separate roadmap item ("clusterization"). The
 * function is pure and idempotent: `normalizeIntent(normalizeIntent(x)) ===
 * normalizeIntent(x)`.
 */
export function normalizeIntent(text: string): string {
  return text
    .normalize("NFKC") // fold unicode width/compatibility variants
    .toLowerCase()
    .replace(/\s+/gu, " ") // collapse all internal whitespace runs to one space
    .trim()
    .replace(/[.!?,;:\s]+$/u, ""); // drop trailing sentence punctuation/space
}
