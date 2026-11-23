/**
 * Which tools an intent graph lifts that the agent can no longer call (RC-722).
 *
 * A tool counts as gone only when all three hold:
 * - the project publishes a tool catalog at all (an OpenTelemetry-only agent
 *   never does, and then every tool would look gone);
 * - the catalog has no entry for it;
 * - the agent has not called it for `GONE_TOOL_GRACE_DAYS`. Snapshots drop
 *   tools for transient reasons (an upstream server down, a group flagged
 *   off, a canary with a subset), and a tool still being called is not gone.
 *
 * The same rule drives the Adaptive ranking warning, the MCP tool and the
 * Cloud graph rebuild, which drops gone tools' edges (./prune-gone-tools.ts).
 * Pure: the reads and the flag are in ./catalog-drift-queries.ts.
 */

export const CATALOG_DRIFT_FLAG = "cloud-ranking-catalog-drift" as const;

export const GONE_TOOL_GRACE_DAYS = 14;

export interface CatalogDrift {
  /** False when the project has no tool catalog: nothing can be called gone. */
  hasCatalog: boolean;
  /** Tool ids, of those asked about, that are gone. */
  gone: Set<string>;
}

/** The rule, on the facts: the catalog's tool ids and the tools called within the grace period. */
export function goneTools(
  toolIds: Iterable<string>,
  catalogToolIds: ReadonlySet<string>,
  recentlyCalled: ReadonlySet<string>,
): CatalogDrift {
  const hasCatalog = catalogToolIds.size > 0;
  const gone = new Set<string>();
  if (!hasCatalog) return { hasCatalog, gone };
  for (const id of toolIds) {
    if (!catalogToolIds.has(id) && !recentlyCalled.has(id)) gone.add(id);
  }
  return { hasCatalog, gone };
}

/**
 * `kind:id` keys the page and MCP mark as missing: skills as before, tools by
 * the gone rule. `detailMissing` is `getIntentGraphDetail`'s set.
 */
export function missingCapabilityKeys(
  detailMissing: ReadonlySet<string>,
  drift: CatalogDrift,
): Set<string> {
  const keys = new Set([...detailMissing].filter((key) => !key.startsWith("tool:")));
  for (const id of drift.gone) keys.add(`tool:${id}`);
  return keys;
}
