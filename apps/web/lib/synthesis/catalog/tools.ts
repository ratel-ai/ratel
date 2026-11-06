import type { ObservedTool, SyncedTool } from "@/lib/ingest/catalogs/queries";
import type { DataProvenance } from "@/lib/synthesis/catalog/provenance";

export type SyncedToolDefinition = {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
};

export type CatalogTool = {
  name: string;
  description: string;
  calls: number;
  callsProvenance: DataProvenance;
  tokens: number;
  tokensProvenance: DataProvenance;
  costUsd: number;
  costProvenance: DataProvenance;
  lastSeenAt: Date | null;
  definition?: SyncedToolDefinition | null;
  sources: SyncedTool[];
};

/** Union source definitions by tool name and layer direct facts over OTel estimates. */
export function buildToolsCatalog(
  observed: readonly ObservedTool[],
  syncedOrDefinitions: readonly SyncedTool[] | readonly SyncedToolDefinition[] = [],
  definitions: readonly SyncedToolDefinition[] = [],
): CatalogTool[] {
  const synced = syncedOrDefinitions.filter(isSyncedTool);
  const persistentDefinitions = [
    ...syncedOrDefinitions.filter((tool): tool is SyncedToolDefinition => !isSyncedTool(tool)),
    ...definitions,
  ];
  const observedByName = new Map(observed.map((tool) => [tool.name, tool]));
  const syncedByName = groupSyncedTools(synced);
  const definitionByName = new Map(
    persistentDefinitions.map((definition) => [definition.name, definition]),
  );
  const names = new Set([
    ...observedByName.keys(),
    ...syncedByName.keys(),
    ...definitionByName.keys(),
  ]);

  return [...names]
    .map((name) =>
      buildTool(
        name,
        observedByName.get(name),
        syncedByName.get(name) ?? [],
        definitionByName.get(name),
      ),
    )
    .sort((a, b) => {
      if (a.calls !== b.calls) return b.calls - a.calls;
      if (a.tokens !== b.tokens) return b.tokens - a.tokens;
      return a.name.localeCompare(b.name);
    });
}

function groupSyncedTools(tools: readonly SyncedTool[]): Map<string, SyncedTool[]> {
  const grouped = new Map<string, SyncedTool[]>();
  for (const tool of tools) {
    const group = grouped.get(tool.name) ?? [];
    group.push(tool);
    grouped.set(tool.name, group);
  }
  return grouped;
}

function buildTool(
  name: string,
  observed: ObservedTool | undefined,
  sources: SyncedTool[],
  definition: SyncedToolDefinition | undefined,
): CatalogTool {
  // A synced source only carries exact counters once its facts era has started;
  // a catalog-only snapshot must not flip observed OTel counts to "facts".
  const hasFacts = sources.some((source) => source.factsStartedAt !== null);
  const calls = hasFacts
    ? sources.reduce((total, source) => total + source.calls, 0)
    : (observed?.calls ?? 0);
  const lastSeenAt =
    newest(sources.map((source) => source.lastUsedAt).filter((date): date is Date => !!date)) ??
    observed?.lastSeenAt ??
    null;
  return {
    name,
    description:
      sources.find((source) => source.description)?.description ?? definition?.description ?? "",
    calls,
    callsProvenance: hasFacts ? "facts" : observed ? "otel" : "absent",
    tokens: observed?.tokens ?? 0,
    tokensProvenance: observed ? "otel" : "absent",
    costUsd: observed?.costUsd ?? 0,
    costProvenance: observed ? "otel" : "absent",
    lastSeenAt,
    definition: definition ?? null,
    sources,
  };
}

function isSyncedTool(tool: SyncedTool | SyncedToolDefinition): tool is SyncedTool {
  return "sourceId" in tool;
}

function newest(dates: Date[]): Date | null {
  return dates.reduce<Date | null>(
    (latest, date) => (!latest || date > latest ? date : latest),
    null,
  );
}
