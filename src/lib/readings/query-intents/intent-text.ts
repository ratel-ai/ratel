/**
 * A trailing context or purpose clause attached to an ask: "cancel their plan
 * *after the requested refund is processed*", "find all usages of X *so they can
 * plan the migration*". The clause is provenance or motive, not the ask, and it
 * drags the phrase toward another cluster. Stripped only when at least two
 * alphanumeric tokens remain in front, so a phrase that IS the clause ("after
 * deploy") is left alone.
 *
 * Applied to working copies only (the BM25 clusterer's), never to the stored
 * text, so a dedup key never changes because of it.
 */
const TRAILING_CONTEXT =
  /\s+(?:after|following|once|then|so that|so (?:they|we|i|you|he|she) (?:can|could)|in order to|as soon as|now that|whenever|before)\s+\S.*$/iu;

export function stripTrailingContext(text: string): string {
  const match = TRAILING_CONTEXT.exec(text);
  if (!match) return text;
  const head = text.slice(0, match.index);
  const headTokens = head.match(/[\p{L}\p{N}]+/gu) ?? [];
  return headTokens.length >= 2 ? head.trim() : text;
}
