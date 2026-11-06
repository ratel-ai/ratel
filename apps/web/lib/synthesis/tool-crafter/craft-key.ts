/**
 * One drafted change, whatever run or rule drafted it: its kind and the tools
 * it changes, in any order. Dismissals are kept by it, so dismissing a merge
 * of two tools keeps every later merge of the same two away, the
 * project-wide pair's and an intent's alike. Pure, so Fixes can read it.
 */
export function craftKey(kind: string, sourceToolIds: readonly string[]): string {
  return `${kind}:${[...sourceToolIds].sort().join(",")}`;
}
