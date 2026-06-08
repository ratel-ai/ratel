const MAX_DESCRIPTION_LEN = 160;

/**
 * Collapse whitespace and clip a description to {@link MAX_DESCRIPTION_LEN},
 * cutting on a word boundary and appending an ellipsis. Shared by the tool and
 * skill gateways so listed descriptions stay compact.
 */
export function compactDescription(s: string): string {
  const collapsed = s.trim().replace(/\s+/g, " ");
  if (collapsed.length <= MAX_DESCRIPTION_LEN) return collapsed;
  const cut = collapsed.slice(0, MAX_DESCRIPTION_LEN - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const head = lastSpace > 80 ? cut.slice(0, lastSpace) : cut;
  return `${head.trimEnd()}…`;
}
