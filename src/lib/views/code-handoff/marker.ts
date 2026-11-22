/**
 * The fix marker (RC-862): a line `ratel-fix: <fixId>` in an issue, a pull
 * request or a commit message ties that change back to a Ratel fix. Pure.
 *
 * Fix ids are `<source>:<uuid>` (see `lib/fixes/types.ts`): `craft:`,
 * `rewrite:` or `issue:`. An `intent:` fix carries a free-text topic id and
 * names no code change, so it is not a marker. Anything else is ignored.
 */

const FIX_ID_SOURCES = ["craft", "rewrite", "issue"] as const;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const MARKER_PATTERN = new RegExp(
  `ratel-fix:[ \\t]*((?:${FIX_ID_SOURCES.join("|")}):${UUID})(?![0-9a-z-])`,
  "gi",
);

/** The marker line for one fix. */
export function fixMarker(fixId: string): string {
  return `ratel-fix: ${fixId}`;
}

/** Every well-formed fix id marked in `text`, once each, in order of first mention, lowercased. */
export function parseFixMarkers(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(MARKER_PATTERN)) ids.add(match[1].toLowerCase());
  return [...ids];
}
