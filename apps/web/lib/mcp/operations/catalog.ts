import { z } from "zod";
import { serializeSkillFull } from "@/lib/catalog/agent-tools/serialize";
import { SKILL_STATUSES, type SkillStatus } from "@/lib/catalog/manage";
import { getProjectCatalogVersion, getSkillById, listSkills } from "@/lib/catalog/queries";
import type { Skill } from "@/lib/catalog/schema";
import {
  buildSkillItems,
  type CatalogProvenance,
  type SearchableState,
  type SkillItem,
  type SkillRun,
  type ToolItem,
  toolItemFromRow,
} from "@/lib/console/catalog/items";
import {
  loadSkillsCatalog,
  loadToolsCatalog,
  type SkillsCatalogData,
  type ToolsCatalogData,
} from "@/lib/console/catalog/load";
import { adoptionNotice } from "@/lib/console/catalog/searchable";
import {
  itemMatchesQuery,
  type SkillsSortKey,
  sortSkillItems,
} from "@/lib/console/catalog/skills-view";
import {
  buildToolsCatalogRows,
  type SortDirection,
  sortToolsCatalogRows,
  type ToolsCatalogRow,
  type ToolsCatalogSortKey,
} from "@/lib/console/catalog/table-view";
import {
  getCatalogCounts,
  listObservedTools,
  listSkillRunCounts,
  listSyncedTools,
  listToolDefinitions,
} from "@/lib/ingest/catalogs/queries";
import {
  listTelemetryDeclaredTools,
  type TelemetryDeclaredTool,
} from "@/lib/ingest/catalogs/telemetry-declared-tools";
import { listRuntimeCatalogOverrides } from "@/lib/ingest/runtime-catalog/override-queries";
import { notFound } from "@/lib/mcp/errors";
import { endUserIdParam, projectScoped, uuidParam } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import {
  capRows,
  detailSkill,
  limitParam,
  round,
  summarizeSkill,
  TruncationTracker,
} from "@/lib/mcp/serialize";
import { APP_NAME } from "@/lib/platform/app-config";
import { getLogger } from "@/lib/platform/logger";
import { getSkillCatalogAdoption } from "@/lib/synthesis/catalog/runtime-reads";

const logger = getLogger("mcp/operations/catalog");

/**
 * The catalog: what the retrieval engine can actually see.
 *
 * The distinction that matters throughout is stored versus observed. Skills and
 * synced tool definitions are what the project has declared; observed tools are
 * what telemetry has actually seen called. A gap in either direction is the
 * interesting finding, which is why both are exposed rather than one merged
 * view.
 */
export interface CatalogOperationDeps {
  listSkills: typeof listSkills;
  getSkillById: typeof getSkillById;
  getCatalogCounts: typeof getCatalogCounts;
  getSkillCatalogAdoption: typeof getSkillCatalogAdoption;
  getProjectCatalogVersion: typeof getProjectCatalogVersion;
  listSyncedTools: typeof listSyncedTools;
  listObservedTools: typeof listObservedTools;
  listToolDefinitions: typeof listToolDefinitions;
  /** The tools the agent declared in its telemetry (AOBS-7). Absent, none is listed. */
  listTelemetryDeclaredTools?: (projectId: string) => Promise<TelemetryDeclaredTool[]>;
  listRuntimeCatalogOverrides: typeof listRuntimeCatalogOverrides;
  listSkillRunCounts: (projectId: string) => ReturnType<typeof listSkillRunCounts>;
  /** The Catalog page's tools read (`lib/catalog/v2/load.ts`). */
  loadToolsCatalog: (projectId: string) => Promise<ToolsCatalogData>;
  /** The Catalog page's skills read, without SKILL.md bodies. */
  loadSkillsCatalog: (projectId: string) => Promise<SkillsCatalogData>;
}

export const defaultCatalogDeps: CatalogOperationDeps = {
  listSkills,
  getSkillById,
  getCatalogCounts,
  getSkillCatalogAdoption,
  getProjectCatalogVersion,
  listSyncedTools,
  listObservedTools,
  listToolDefinitions,
  listTelemetryDeclaredTools: (projectId) => listTelemetryDeclaredTools(projectId),
  listRuntimeCatalogOverrides,
  listSkillRunCounts: (projectId) => listSkillRunCounts(projectId),
  loadToolsCatalog,
  // The organization argument is unused by the loader; bodies are left out, as on the Catalog home.
  loadSkillsCatalog: (projectId) => loadSkillsCatalog(projectId, null, { bodies: false }),
};

/** Every Cloud skill the console's Skills table can show; the in-memory search and sort scan up to this many. */
const SKILL_SCAN_LIMIT = 500;

/** Description text carried per catalog row before the row says it was cut. */
const CATALOG_TEXT_CHARS = 300;

const SKILL_SORTS = ["name", "runs", "updated"] as const satisfies readonly SkillsSortKey[];
const CATALOG_SORTS = [
  "name",
  "calls",
  "tokens",
  "cost",
  "lastSeen",
] as const satisfies readonly ToolsCatalogSortKey[];

const directionParam = z
  .enum(["asc", "desc"])
  .optional()
  .describe("Sort direction. Defaults to ascending for name and descending otherwise.");

const queryParam = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .optional()
  .describe(
    "Case-insensitive text matched against the name, the searchable description and the agent description.",
  );

function defaultDirection(sort: string): SortDirection {
  return sort === "name" ? "asc" : "desc";
}

/** Whether a runtime entry's Cloud copy has reached the runtime, as far as the evidence goes. */
type OverrideAdoption = "adopted" | "not_adopted" | "unconfirmed";

function overrideAdoption(
  searchable: SearchableState,
  adopted: boolean | null,
): OverrideAdoption | null {
  const target = searchable.target;
  if (target.type !== "runtime" || target.override === null) return null;
  const notice = adoptionNotice(searchable, adopted);
  if (notice === null) return "adopted";
  return notice === "still-own-copy" ? "not_adopted" : "unconfirmed";
}

function summarizeSearchable(
  searchable: SearchableState | null,
  adopted: boolean | null,
  tracker: TruncationTracker,
) {
  if (!searchable) return null;
  const target = searchable.target;
  return {
    inEffect: tracker.text(searchable.text, CATALOG_TEXT_CHARS),
    origin: searchable.origin,
    runtimeDefault:
      target.type === "runtime" ? tracker.text(target.runtimeText, CATALOG_TEXT_CHARS) : null,
    override:
      target.type === "runtime"
        ? target.override === null
          ? null
          : tracker.text(target.override, CATALOG_TEXT_CHARS)
        : target.stored === null
          ? null
          : tracker.text(target.stored, CATALOG_TEXT_CHARS),
    overrideAdoption: overrideAdoption(searchable, adopted),
    editable: searchable.editable,
    editWith: target.type === "runtime" ? "set_catalog_override" : "update_skill",
  };
}

function entryIdOf(item: ToolItem | SkillItem): string | null {
  const target = item.searchable?.target;
  return target?.type === "runtime" ? target.entryId : null;
}

function summarizeToolItem(item: ToolItem, adopted: boolean | null, tracker: TruncationTracker) {
  return {
    kind: "tool" as const,
    name: item.name,
    source: item.provenance,
    entryId: entryIdOf(item),
    skillId: null,
    agentDescription:
      item.agentDescription === null
        ? null
        : tracker.text(item.agentDescription, CATALOG_TEXT_CHARS),
    searchable: summarizeSearchable(item.searchable, adopted, tracker),
    tags: item.definition?.tags ?? [],
    stale: item.stale,
    status: null,
    usage: {
      calls: item.calls,
      callsEstimated: item.callsEstimated,
      inputTokens: item.tokens,
      costUsd: round(item.costUsd),
      lastSeenAt: item.lastSeenAt,
    },
  };
}

function summarizeSkillItem(item: SkillItem, adopted: boolean | null, tracker: TruncationTracker) {
  return {
    kind: "skill" as const,
    name: item.name,
    source: item.provenance,
    entryId: entryIdOf(item),
    skillId: item.record?.id ?? null,
    agentDescription:
      item.agentDescription === null
        ? null
        : tracker.text(item.agentDescription, CATALOG_TEXT_CHARS),
    searchable: summarizeSearchable(item.searchable, adopted, tracker),
    tags: item.tags,
    stale: false,
    status: item.status,
    usage: { runs: item.runs, lastSeenAt: item.lastSeenAt },
  };
}

interface CatalogFilter {
  query?: string;
  source: CatalogProvenance | "all";
}

function keep(item: ToolItem | SkillItem, filter: CatalogFilter): boolean {
  if (filter.source !== "all" && item.provenance !== filter.source) return false;
  return filter.query === undefined || itemMatchesQuery(item, filter.query);
}

/** The tools as the Catalog page builds them, filtered, then sorted by the page's own comparator. */
function catalogTools(
  data: ToolsCatalogData,
  filter: CatalogFilter,
  sort: ToolsCatalogSortKey,
  direction: SortDirection,
): ToolItem[] {
  const rows = buildToolsCatalogRows(
    data.tools,
    new Map(data.runtimeEntries.map((entry) => [entry.name, entry])),
  );
  const itemOf = new Map<ToolsCatalogRow, ToolItem>(
    rows.map((row) => [row, toolItemFromRow(row, { editable: data.editable })]),
  );
  const kept = rows.filter((row) => keep(itemOf.get(row)!, filter));
  return sortToolsCatalogRows(kept, sort, direction).map((row) => itemOf.get(row)!);
}

/** A skill has runs, not calls, and no tokens or cost of its own: those sorts fall back to its name. */
function skillSortOf(sort: ToolsCatalogSortKey): SkillsSortKey {
  if (sort === "calls") return "runs";
  if (sort === "lastSeen") return "updated";
  return "name";
}

function catalogSkills(
  data: SkillsCatalogData,
  filter: CatalogFilter,
  sort: ToolsCatalogSortKey,
  direction: SortDirection,
): SkillItem[] {
  const items = buildSkillItems(data).filter((item) => keep(item, filter));
  const skillSort = skillSortOf(sort);
  // Tokens and cost fall back to name order, which reads naturally only ascending.
  return sortSkillItems(
    items,
    skillSort,
    skillSort === "name" && sort !== "name" ? "asc" : direction,
  );
}

/**
 * Cloud skills searched and sorted the way the Skills table does it
 * (`lib/catalog/v2/skills-view.ts`), over the first {@link SKILL_SCAN_LIMIT}.
 */
function searchCloudSkills(
  rows: readonly Skill[],
  runs: Readonly<Record<string, SkillRun>>,
  query: string | undefined,
  sort: SkillsSortKey,
  direction: SortDirection,
): Skill[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const items = buildSkillItems({
    skills: rows.map(serializeSkillFull),
    runtimeSkills: [],
    runs,
    searchableEnabled: true,
    runtimeEditable: true,
  }).filter((item) => query === undefined || itemMatchesQuery(item, query));
  return sortSkillItems(items, sort, direction)
    .map((item) => (item.record ? byId.get(item.record.id) : undefined))
    .filter((row): row is Skill => row !== undefined);
}

export function catalogOperations(deps: CatalogOperationDeps = defaultCatalogDeps): McpOperation[] {
  return [
    defineOperation({
      id: "list_skills",
      domain: "catalog",
      title: "List skills",
      description: `${APP_NAME} skills in the project catalog with their status, tags, and a preview of the body. Filter by status or end user, search by name or description, sort by name, runs or last update. Use get_skill for a full body.`,
      keywords: ["skills", "catalog", "capabilities", "published", "draft", "search skills"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        status: z
          .enum(SKILL_STATUSES as unknown as [SkillStatus, ...SkillStatus[]])
          .optional()
          .describe("Restrict to one lifecycle status."),
        endUserId: endUserIdParam,
        query: queryParam,
        sort: z
          .enum(SKILL_SORTS)
          .optional()
          .describe("Order as the Skills table does. Omitted: most recently updated first."),
        direction: directionParam,
        limit: limitParam,
        offset: z.number().int().min(0).default(0),
      }),
      async execute(ctx, params) {
        const tracker = new TruncationTracker();

        // The plain listing pages in the database. Search and sort scan the
        // skills the Skills table loads and page in memory, as the table does.
        if (params.query === undefined && params.sort === undefined) {
          // Over-fetch by one so the truncation marker reflects "there is more"
          // rather than "the page happened to fill".
          const rows = await deps.listSkills(ctx.projectId, {
            status: params.status,
            endUser: params.endUserId,
            limit: params.limit + 1,
            offset: params.offset,
          });
          const page = tracker.take(capRows(rows, params.limit));
          return {
            data: {
              count: page.length,
              offset: params.offset,
              skills: page.map((row) => summarizeSkill(row, tracker)),
            },
            truncated: tracker.value,
            hint: "get_skill returns one skill's full body. list_search_queries_for_skill shows which real queries retrieve it.",
          };
        }

        const sort = params.sort ?? "updated";
        const [rows, runCounts] = await Promise.all([
          deps.listSkills(ctx.projectId, {
            status: params.status,
            endUser: params.endUserId,
            limit: SKILL_SCAN_LIMIT,
          }),
          sort === "runs" ? deps.listSkillRunCounts(ctx.projectId) : Promise.resolve([]),
        ]);
        const runs: Record<string, SkillRun> = Object.fromEntries(
          runCounts.map((count) => [
            count.skillId,
            { runs: count.runs, lastRunAt: count.lastRunAt.toISOString() },
          ]),
        );
        const matched = searchCloudSkills(
          rows,
          runs,
          params.query,
          sort,
          params.direction ?? defaultDirection(sort),
        );
        const page = tracker.take(capRows(matched.slice(params.offset), params.limit));

        return {
          data: {
            count: page.length,
            total: matched.length,
            offset: params.offset,
            skills: page.map((row) => ({
              ...summarizeSkill(row, tracker),
              ...(sort === "runs" ? { runs: runs[row.name]?.runs ?? 0 } : {}),
            })),
          },
          truncated: tracker.value,
          hint:
            rows.length >= SKILL_SCAN_LIMIT
              ? `Search and sort cover the first ${SKILL_SCAN_LIMIT} skills; narrow by status to reach the rest.`
              : "get_skill returns one skill's full body. list_runtime_catalog also covers skills the runtime registered.",
        };
      },
    }),
    defineOperation({
      id: "get_skill",
      domain: "catalog",
      title: "Get skill",
      description: "One skill in full, including the complete body text and both descriptions.",
      keywords: ["one skill", "full body", "instructions"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped, skillId: uuidParam() }),
      async execute(ctx, params) {
        const skill = await deps.getSkillById(ctx.projectId, params.skillId);
        if (!skill) throw notFound("skill");
        return { data: { skill: detailSkill(skill) } };
      },
    }),
    defineOperation({
      id: "get_catalog_status",
      domain: "catalog",
      title: "Catalog status",
      description:
        "One-call health check for a project's catalog: how many skills and tools exist, how many tools carry a usable description, the published catalog version, and whether the runtime has adopted it.",
      keywords: ["catalog", "catalog health", "adoption", "catalog version"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
        const [counts, adopted, version] = await Promise.all([
          deps.getCatalogCounts(ctx.projectId, {}),
          deps.getSkillCatalogAdoption(ctx.projectId),
          deps.getProjectCatalogVersion(ctx.projectId),
        ]);
        return {
          data: {
            counts,
            publishedCatalogVersion: version,
            runtimeHasAdoptedCatalog: adopted,
          },
          hint: "list_declared_tools flags tools with no description: those can never be retrieved, whatever the query.",
        };
      },
    }),
    defineOperation({
      id: "list_declared_tools",
      domain: "catalog",
      title: "Tools the runtime declares",
      description:
        "Tools the runtime has declared to Ratel, with their definitions and freshness. Flags any with no description text, which is the single most common reason a tool is never retrieved. This is what the runtime says exists; list_invoked_tools is what telemetry has seen actually called.",
      keywords: [
        "what tools exist",
        "declared",
        "tool definitions",
        "runtime catalog",
        "undescribed",
      ],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        includeInactive: z.boolean().default(false),
        limit: limitParam,
      }),
      async execute(ctx, params) {
        const tracker = new TruncationTracker();
        const [synced, definitions, telemetry] = await Promise.all([
          deps.listSyncedTools(ctx.projectId, {
            includeInactive: params.includeInactive,
          }),
          deps.listToolDefinitions(ctx.projectId),
          telemetryDeclaredTools(ctx.projectId, deps),
        ]);

        const describedNames = new Set(
          definitions
            .filter((definition) => (definition.description ?? "").trim().length > 0)
            .map((definition) => definition.name),
        );
        const page = tracker.take(capRows(synced, params.limit));
        const undescribed = synced
          .filter((tool) => !describedNames.has(tool.name))
          .map((tool) => tool.name);

        // AOBS-7: an agent that declares its tools only in its telemetry
        // (`gen_ai.tool.definitions`) syncs nothing: list those names too.
        const syncedNames = new Set(synced.map((tool) => tool.name));
        const telemetryOnly = telemetry?.filter((tool) => !syncedNames.has(tool.name)) ?? [];
        const telemetryPage = tracker.take(capRows(telemetryOnly, params.limit));

        return {
          data: {
            count: page.length,
            totalSynced: synced.length,
            undescribedCount: undescribed.length,
            undescribedTools: undescribed.slice(0, 25),
            tools: page.map((tool) => ({
              ...tool,
              hasDescription: describedNames.has(tool.name),
            })),
            ...(telemetry
              ? {
                  telemetryDeclaredCount: telemetryOnly.length,
                  telemetryDeclaredTools: telemetryPage.map((tool) => ({
                    name: tool.name,
                    lastDeclaredAt: tool.lastDeclaredAt.toISOString(),
                    modelCalls: tool.modelCalls,
                  })),
                }
              : {}),
          },
          truncated: tracker.value,
          hint:
            [
              undescribed.length
                ? "Tools listed in undescribedTools have no definition text. A tool known only by name has nothing for a prompt to match, so it can never be retrieved."
                : null,
              telemetryOnly.length
                ? "telemetryDeclaredTools are the tools the agent declared to the model in its traces in the last 30 days and did not sync: names only, with no definition text."
                : null,
            ]
              .filter(Boolean)
              .join(" ") || undefined,
        };
      },
    }),
    defineOperation({
      id: "list_invoked_tools",
      domain: "catalog",
      title: "Tools telemetry has seen called",
      description:
        "Tools telemetry has actually seen invoked, with call counts, token usage, cost, and last-seen time. Compare against list_declared_tools to find declared-but-unused or used-but-undeclared tools.",
      keywords: [
        "which tools are used",
        "tools never called",
        "invoked",
        "call counts",
        "telemetry",
      ],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped, limit: limitParam }),
      async execute(ctx, params) {
        const tracker = new TruncationTracker();
        const observed = await deps.listObservedTools(ctx.projectId);
        const page = tracker.take(capRows(observed, params.limit));
        return {
          data: { count: page.length, total: observed.length, tools: page },
          truncated: tracker.value,
        };
      },
    }),
    defineOperation({
      id: "list_catalog_overrides",
      domain: "catalog",
      title: "List retrieval-description overrides",
      description: `Searchable-description overrides set in ${APP_NAME} for runtime catalog entries, which replace the description the runtime would otherwise match on.`,
      keywords: ["override", "overrides set", "searchable", "runtime catalog"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped, limit: limitParam }),
      async execute(ctx, params) {
        const tracker = new TruncationTracker();
        const overrides = await deps.listRuntimeCatalogOverrides(ctx.projectId);
        const page = tracker.take(capRows(overrides, params.limit));
        return {
          data: {
            count: page.length,
            total: overrides.length,
            overrides: page.map((override) => ({
              kind: override.kind,
              entryId: override.entryId,
              searchableDescription: tracker.text(override.searchableDescription),
            })),
          },
          truncated: tracker.value,
          hint: "list_runtime_catalog shows each entry's runtime text next to its override, and whether the runtime has picked the override up.",
        };
      },
    }),
    defineOperation({
      id: "list_runtime_catalog",
      domain: "catalog",
      title: "Catalog tools and skills",
      description:
        "The tools and skills the Catalog page shows, with each one's entryId, agent description, searchable description in effect and where it comes from, the runtime default, any override and whether the runtime adopted it, tags, staleness and usage. Take entryId from here for set_catalog_override.",
      keywords: [
        "catalog entries",
        "entry id",
        "agent description",
        "description in effect",
        "runtime skills",
      ],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        kind: z
          .enum(["tool", "skill", "all"])
          .default("all")
          .describe("Restrict to tools or skills."),
        query: queryParam,
        source: z
          .enum(["managed", "observed", "cloud", "all"])
          .default("all")
          .describe(
            `managed: synced from the runtime, editable with set_catalog_override. observed: seen in traces only. cloud: skills created in ${APP_NAME}.`,
          ),
        sort: z
          .enum(CATALOG_SORTS)
          .default("calls")
          .describe("Skills sort by runs for calls; tokens and cost apply to tools."),
        direction: directionParam,
        limit: limitParam,
        offset: z.number().int().min(0).default(0),
      }),
      async execute(ctx, params) {
        const tracker = new TruncationTracker();
        const filter: CatalogFilter = { query: params.query, source: params.source };
        const direction = params.direction ?? defaultDirection(params.sort);
        const [tools, skills] = await Promise.all([
          params.kind === "skill" ? Promise.resolve(null) : deps.loadToolsCatalog(ctx.projectId),
          params.kind === "tool" ? Promise.resolve(null) : deps.loadSkillsCatalog(ctx.projectId),
        ]);

        // Tools first, then skills: the order the Catalog tree lists them in.
        const toolItems = tools ? catalogTools(tools, filter, params.sort, direction) : [];
        const skillItems = skills ? catalogSkills(skills, filter, params.sort, direction) : [];
        const matched = [
          ...toolItems.map(
            (item) => () => summarizeToolItem(item, tools?.adopted ?? null, tracker),
          ),
          ...skillItems.map(
            (item) => () => summarizeSkillItem(item, skills?.adopted ?? null, tracker),
          ),
        ];
        const page = tracker.take(capRows(matched.slice(params.offset), params.limit));

        return {
          data: {
            count: page.length,
            total: matched.length,
            offset: params.offset,
            totals: { tools: toolItems.length, skills: skillItems.length },
            entries: page.map((summarize) => summarize()),
          },
          truncated: tracker.value,
          hint: `set_catalog_override takes kind and entryId from an entry whose searchable.editWith is set_catalog_override; a ${APP_NAME} skill (skillId) is edited with update_skill. An entry with no entryId was only seen in traces and cannot be overridden.`,
        };
      },
    }),
  ];
}

/** Exported for tests that assert cost rounding stays stable. */
export const __testing = { round };

/**
 * The tools the agent declared in its telemetry (AOBS-7); null without a read.
 * A failed read lists none: the synced tools are the operation's established
 * answer.
 */
async function telemetryDeclaredTools(
  projectId: string,
  deps: CatalogOperationDeps,
): Promise<TelemetryDeclaredTool[] | null> {
  if (!deps.listTelemetryDeclaredTools) return null;
  try {
    return await deps.listTelemetryDeclaredTools(projectId);
  } catch (err) {
    logger.error({ err, project_id: projectId }, "telemetry declared tools read failed");
    return null;
  }
}
