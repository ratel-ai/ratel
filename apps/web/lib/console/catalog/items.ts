import type { SkillFull } from "@/lib/catalog/agent-tools/outputs";
import type { ToolsCatalogRow } from "@/lib/console/catalog/table-view";
import type { CatalogTool } from "@/lib/console/catalog/tools";
import type { SyncedTool } from "@/lib/ingest/catalogs/queries";
import type { RuntimeCatalogDefinition, RuntimeCatalogEntry } from "@/lib/synthesis/dashboard";
import { resolveSearchableDescription } from "@/lib/synthesis/playground/descriptions";
import { itemKey } from "./item-id";

/**
 * One shape for every catalog item, tool or skill, so the tree, the detail
 * and the tables read the same fields. Built from the rows the v1 loaders
 * already return (`buildToolsCatalogRows`, `serializeSkillFull`, the runtime
 * catalog entries); nothing here reads the database.
 */

/** Synced from the runtime, seen in traces only, or created in Cloud. */
export type CatalogProvenance = "managed" | "observed" | "cloud";

export type SkillStatus = "draft" | "published" | "archived";

/** Where a saved searchable description is written. */
export type SearchableTarget =
  | {
      type: "runtime";
      kind: "tool" | "skill";
      entryId: string;
      /** The runtime's own text, which applies again once the Cloud copy is cleared. */
      runtimeText: string;
      /** The Cloud copy, when one is set. */
      override: string | null;
      useCloudDefinitions: boolean;
    }
  | {
      type: "skill";
      skillId: string;
      /** The skills route's optimistic-concurrency guard. */
      version: number;
      /** The stored text; null means the skill is matched on its description. */
      stored: string | null;
    };

/** Where the text that matching reads comes from: set here, sent by the runtime, or the agent description itself. */
export type SearchableOrigin = "cloud" | "runtime" | "agent";

export interface SearchableState {
  /** What matching reads right now. */
  text: string;
  origin: SearchableOrigin;
  target: SearchableTarget;
  editable: boolean;
}

interface ItemBase {
  /** `tool:<name>` or `skill:<id>`, the value of `?item=`. */
  key: string;
  name: string;
  provenance: CatalogProvenance;
  /** What the agent receives. Null when nothing was ever registered. */
  agentDescription: string | null;
  /** Null when there is no searchable text to show (observed, or the field is not rolled out). */
  searchable: SearchableState | null;
  lastSeenAt: string | null;
}

export interface ToolItem extends ItemBase {
  kind: "tool";
  calls: number;
  /** Calls reconstructed from traces rather than counted by the runtime. */
  callsEstimated: boolean;
  /** Null when no traces mention the tool. */
  tokens: number | null;
  costUsd: number | null;
  /** Every runtime source for it has been quiet past the staleness threshold. */
  stale: boolean;
  /** The runtime source it is synced from, freshest first. */
  source: string | null;
  /** Whether that source is still publishing; a leftover stale source must not reshape the tree. */
  sourceFresh: boolean;
  /**
   * The tool's ids as the runtime registered it. The SDK names a tool it took
   * from an MCP server `<server>__<tool>` in its id while keeping the bare
   * name, so grouping by server reads these, not the name.
   */
  ids: string[];
  definition: { inputSchema: unknown; outputSchema: unknown; tags: string[] } | null;
}

export interface SkillRun {
  runs: number;
  lastRunAt: string | null;
}

export interface SkillItem extends ItemBase {
  kind: "skill";
  runs: number;
  /** Cloud skills only. */
  status: SkillStatus | null;
  /** The full Cloud skill (instructions, tags, version); null for runtime and observed skills. */
  record: SkillFull | null;
  tags: string[];
  updatedAt: string | null;
}

export type CatalogItem = ToolItem | SkillItem;

/** ISO text for a date that may have crossed the server boundary as a Date or a string. */
export function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sameText(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

/** The searchable state of an entry the runtime registered: its text, or the Cloud copy over it. */
export function runtimeSearchable(
  kind: "tool" | "skill",
  definition: RuntimeCatalogDefinition,
  editable: boolean,
): SearchableState {
  const override = definition.searchableDescriptionOverride;
  const runtimeText = definition.searchableDescription;
  return {
    text: resolveSearchableDescription({
      description: definition.description,
      searchableDescription: runtimeText,
      searchableDescriptionOverride: override,
    }),
    origin:
      override !== null
        ? "cloud"
        : sameText(runtimeText, definition.description)
          ? "agent"
          : "runtime",
    editable,
    target: {
      type: "runtime",
      kind,
      entryId: definition.entryId,
      runtimeText,
      override,
      useCloudDefinitions: definition.useCloudDefinitions === true,
    },
  };
}

/** The searchable state of a Cloud skill: its own text, or its description when it has none. */
export function cloudSkillSearchable(
  record: Pick<SkillFull, "id" | "version" | "description" | "searchableDescription">,
): SearchableState {
  const stored = record.searchableDescription;
  return {
    text: stored ?? record.description,
    origin: stored !== null && !sameText(stored, record.description) ? "cloud" : "agent",
    editable: true,
    target: { type: "skill", skillId: record.id, version: record.version, stored },
  };
}

const SOURCE_RANK: Record<SyncedTool["sourceStatus"], number> = { fresh: 0, stale: 1, inactive: 2 };

type SourceFields = Pick<SyncedTool, "sourceId" | "sourceStatus" | "sourceLastSeenAt">;

function rankSources<T extends SourceFields>(sources: readonly T[]): T[] {
  return [...sources].sort(
    (a, b) =>
      SOURCE_RANK[a.sourceStatus] - SOURCE_RANK[b.sourceStatus] ||
      new Date(b.sourceLastSeenAt).getTime() - new Date(a.sourceLastSeenAt).getTime() ||
      a.sourceId.localeCompare(b.sourceId),
  );
}

/** The runtime source a tool is synced from: the freshest one when several publish it. */
export function primarySource(sources: readonly SourceFields[]): string | null {
  return rankSources(sources)[0]?.sourceId ?? null;
}

/** A tools-catalog row (`buildToolsCatalogRows`) as a catalog item. */
export function toolItemFromRow(row: ToolsCatalogRow, options: { editable: boolean }): ToolItem {
  const { tool, definition } = row;
  return {
    kind: "tool",
    key: itemKey("tool", tool.name),
    name: tool.name,
    provenance: row.provenance === "managed" ? "managed" : "observed",
    agentDescription: definition
      ? definition.description
      : tool.description.trim() !== ""
        ? tool.description
        : null,
    searchable: definition ? runtimeSearchable("tool", definition, options.editable) : null,
    lastSeenAt: isoOrNull(tool.lastSeenAt),
    calls: tool.calls,
    callsEstimated: tool.callsProvenance === "otel",
    tokens: tool.tokensProvenance === "absent" ? null : tool.tokens,
    costUsd: tool.costProvenance === "absent" ? null : tool.costUsd,
    stale: row.stale,
    source: primarySource(tool.sources),
    sourceFresh: rankSources(tool.sources)[0]?.sourceStatus === "fresh",
    ids: [
      ...new Set(
        [definition?.entryId, ...tool.sources.map((source) => source.toolId)].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    ],
    definition: definition
      ? {
          inputSchema: definition.inputSchema ?? null,
          outputSchema: definition.outputSchema ?? null,
          tags: definition.tags,
        }
      : tool.definition?.parameters
        ? { inputSchema: tool.definition.parameters, outputSchema: null, tags: [] }
        : null,
  };
}

export function skillStatus(value: string): SkillStatus | null {
  return value === "draft" || value === "published" || value === "archived" ? value : null;
}

export interface SkillItemsInput {
  skills: readonly SkillFull[];
  runtimeSkills: readonly RuntimeCatalogEntry[];
  /** Runs per skill id as the runtime reports it (a Cloud skill's name). */
  runs: Readonly<Record<string, SkillRun>>;
  /** Cloud skills carry a searchable description (`cloud-catalog-v2`). */
  searchableEnabled: boolean;
  /** Cloud copies of runtime skills' text can be saved (`cloud-runtime-catalog-ui`). */
  runtimeEditable: boolean;
}

/** Cloud skills first, then the ones only a runtime registered or traces mention. */
export function buildSkillItems(input: SkillItemsInput): SkillItem[] {
  return [
    ...input.skills.map((record) => cloudSkillItem(record, input)),
    ...input.runtimeSkills.map((entry) => runtimeSkillItem(entry, input)),
  ];
}

function cloudSkillItem(record: SkillFull, input: SkillItemsInput): SkillItem {
  const run = input.runs[record.name];
  return {
    kind: "skill",
    key: itemKey("skill", record.id),
    name: record.name,
    provenance: "cloud",
    agentDescription: record.description,
    searchable: input.searchableEnabled ? cloudSkillSearchable(record) : null,
    lastSeenAt: run?.lastRunAt ?? null,
    runs: run?.runs ?? 0,
    status: skillStatus(record.status),
    record,
    tags: record.tags,
    updatedAt: record.updatedAt,
  };
}

function runtimeSkillItem(entry: RuntimeCatalogEntry, input: SkillItemsInput): SkillItem {
  const run =
    input.runs[entry.name] ?? (entry.entryId !== null ? input.runs[entry.entryId] : undefined);
  const shared = {
    kind: "skill" as const,
    name: entry.name,
    lastSeenAt: run?.lastRunAt ?? isoOrNull(entry.lastSeenAt),
    runs: run?.runs ?? 0,
    status: null,
    record: null,
    updatedAt: null,
  };
  if (entry.entryId === null) {
    return {
      ...shared,
      key: itemKey("skill", entry.name),
      provenance: "observed",
      agentDescription: null,
      searchable: null,
      tags: [],
    };
  }
  return {
    ...shared,
    key: itemKey("skill", entry.entryId),
    provenance: "managed",
    agentDescription: entry.description,
    searchable: runtimeSearchable("skill", entry, input.runtimeEditable),
    tags: entry.tags,
  };
}

/* ------------------------------ local edits ------------------------------- */

/** Where a Cloud copy saved in this session belongs: `<kind>:<entryId>`. */
export function overrideKey(kind: "tool" | "skill", entryId: string): string {
  return `${kind}:${entryId}`;
}

/**
 * Runtime entries with the Cloud copies saved in this session applied, so a
 * save shows everywhere at once without re-reading the catalog. Untouched
 * entries keep their identity.
 */
export function withRuntimeOverrides<T extends RuntimeCatalogEntry>(
  entries: readonly T[],
  kind: "tool" | "skill",
  overrides: ReadonlyMap<string, string | null>,
): T[] {
  return entries.map((entry) => {
    if (entry.entryId === null) return entry;
    const key = overrideKey(kind, entry.entryId);
    return overrides.has(key)
      ? { ...entry, searchableDescriptionOverride: overrides.get(key) ?? null }
      : entry;
  });
}

/**
 * Cloud skills with the records returned by this session's writes applied.
 * A newer server copy (a refresh after someone else's edit) wins over an
 * older local one.
 */
export function withSkillRecords(
  skills: readonly SkillFull[],
  records: ReadonlyMap<string, SkillFull>,
): SkillFull[] {
  return skills.map((skill) => {
    const local = records.get(skill.id);
    return local && local.version >= skill.version ? local : skill;
  });
}

/* --------------------------- publish and archive -------------------------- */

export type SkillTransition = "publish" | "archive";

/** What a skill can do next: publish a draft or an archived skill, archive anything not archived. */
export function skillTransitions(status: SkillStatus | null): SkillTransition[] {
  if (status === "draft") return ["publish", "archive"];
  if (status === "published") return ["archive"];
  if (status === "archived") return ["publish"];
  return [];
}

export function transitionStatus(transition: SkillTransition): SkillStatus {
  return transition === "publish" ? "published" : "archived";
}

/**
 * The transition that restores `from` after a move to `to`, or null when none
 * does. Published and archived swap back exactly; nothing returns a skill to
 * draft, so leaving draft has no Undo.
 */
export function undoTransition(from: SkillStatus, to: SkillStatus): SkillTransition | null {
  if (from === "published" && to === "archived") return "publish";
  if (from === "archived" && to === "published") return "archive";
  return null;
}

/* --------------------------------- totals --------------------------------- */

export interface ToolTotals {
  tools: number;
  calls: number;
  /** Counted by the runtime for every synced source, not reconstructed from traces. */
  callsExact: boolean;
  tokens: number;
  costUsd: number;
  /** Whether any tool has telemetry behind its tokens and cost. */
  observed: boolean;
}

/**
 * The tools page's headline numbers. Same rules as the v1 page: exact calls
 * from synced sources win when there are any, and the trace estimates of
 * unsynced tools are left out rather than mixed in.
 */
export function summarizeTools(tools: readonly CatalogTool[]): ToolTotals {
  const exact = tools.filter((tool) => tool.callsProvenance === "facts");
  return {
    tools: tools.length,
    calls: (exact.length > 0 ? exact : tools).reduce((sum, tool) => sum + tool.calls, 0),
    callsExact: exact.length > 0,
    tokens: tools.reduce((sum, tool) => sum + tool.tokens, 0),
    costUsd: tools.reduce((sum, tool) => sum + tool.costUsd, 0),
    observed: tools.some(
      (tool) => tool.tokensProvenance !== "absent" || tool.costProvenance !== "absent",
    ),
  };
}
