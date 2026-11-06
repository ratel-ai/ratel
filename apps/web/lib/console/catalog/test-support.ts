import type { SkillFull } from "@/lib/catalog/agent-tools/outputs";
import { buildToolsCatalogRows } from "@/lib/console/catalog/table-view";
import type { ObservedTool, SyncedTool } from "@/lib/ingest/catalogs/queries";
import { buildToolsCatalog } from "@/lib/synthesis/catalog/tools";
import type { RuntimeCatalogDefinition } from "@/lib/synthesis/dashboard";
import { buildSkillItems, type SkillItemsInput, type ToolItem, toolItemFromRow } from "./items";

/** Fixtures shaped like the demo project: a managed catalog, an override and a few observed tools. */

export const NOW = "2026-10-15T12:00:00.000Z";

export function runtimeDefinition(
  name: string,
  patch: Partial<RuntimeCatalogDefinition> = {},
): RuntimeCatalogDefinition {
  const description = patch.description ?? `Does ${name}.`;
  return {
    entryId: name,
    name,
    description,
    tags: [],
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    outputSchema: null,
    searchableDescription: description,
    searchableDescriptionOverridden: false,
    useCloudDefinitions: false,
    provenance: "events",
    searchableDescriptionOverride: null,
    lastSeenAt: new Date("2026-09-14T21:31:57.281Z"),
    ...patch,
  };
}

export function observedTool(
  name: string,
  calls: number,
  patch: Partial<ObservedTool> = {},
): ObservedTool {
  return {
    name,
    calls,
    tokens: calls * 120,
    costUsd: calls * 0.001,
    lastSeenAt: new Date("2026-10-09T12:23:35.578Z"),
    ...patch,
  };
}

export function syncedTool(
  name: string,
  sourceId: string,
  patch: Partial<SyncedTool> = {},
): SyncedTool {
  return {
    sourceId,
    sourceStatus: "fresh",
    sourceLastSeenAt: new Date("2026-10-15T11:00:00.000Z"),
    factsStartedAt: null,
    toolId: name,
    name,
    description: `Does ${name}.`,
    searchableDescription: null,
    inputSchema: null,
    outputSchema: null,
    metadata: null,
    calls: 0,
    errors: 0,
    lastUsedAt: null,
    ...patch,
  };
}

/** Tool items through the same pipeline the pages use: `buildToolsCatalog`, then `buildToolsCatalogRows`. */
export function toolItems(input: {
  observed?: ObservedTool[];
  synced?: SyncedTool[];
  definitions?: RuntimeCatalogDefinition[];
  editable?: boolean;
}): ToolItem[] {
  const definitions = input.definitions ?? [];
  const tools = buildToolsCatalog(input.observed ?? [], input.synced ?? [], definitions);
  const rows = buildToolsCatalogRows(
    tools,
    new Map(definitions.map((definition) => [definition.name, definition])),
  );
  return rows.map((row) => toolItemFromRow(row, { editable: input.editable ?? true }));
}

export function skillRecord(name: string, patch: Partial<SkillFull> = {}): SkillFull {
  return {
    id: `id-${name}`,
    name,
    description: `Use ${name}.`,
    searchableDescription: null,
    tags: [],
    tools: [],
    status: "published",
    version: 1,
    endUserId: null,
    model: null,
    updatedAt: "2026-10-01T10:00:00.000Z",
    publishedAt: "2026-10-01T10:00:00.000Z",
    metadata: {},
    body: `# ${name}\n\nSteps.`,
    createdAt: "2026-09-01T10:00:00.000Z",
    ...patch,
  };
}

export function skillItems(input: Partial<SkillItemsInput>) {
  return buildSkillItems({
    skills: [],
    runtimeSkills: [],
    runs: {},
    searchableEnabled: true,
    runtimeEditable: true,
    ...input,
  });
}
