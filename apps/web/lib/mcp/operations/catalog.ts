import { z } from "zod";
import { SKILL_STATUSES, type SkillStatus } from "@/lib/catalog/manage";
import { getProjectCatalogVersion, getSkillById, listSkills } from "@/lib/catalog/queries";
import {
  getCatalogCounts,
  listObservedTools,
  listSyncedTools,
  listToolDefinitions,
} from "@/lib/ingest/catalogs/queries";
import { listRuntimeCatalogOverrides } from "@/lib/ingest/runtime-catalog/override-queries";
import { notFound } from "@/lib/mcp/errors";
import { endUserIdParam, projectScoped } from "@/lib/mcp/operations/params";
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
import { getSkillCatalogAdoption } from "@/lib/synthesis/catalog/runtime-reads";

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
  listRuntimeCatalogOverrides: typeof listRuntimeCatalogOverrides;
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
  listRuntimeCatalogOverrides,
};

export function catalogOperations(deps: CatalogOperationDeps = defaultCatalogDeps): McpOperation[] {
  return [
    defineOperation({
      id: "list_skills",
      domain: "catalog",
      title: "List skills",
      description:
        "Skills in the project catalog with their status, tags, and a preview of the body. Filter by status or end user. Use get_skill for a full body.",
      keywords: ["skills", "catalog", "capabilities", "published", "draft"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        status: z
          .enum(SKILL_STATUSES as unknown as [SkillStatus, ...SkillStatus[]])
          .optional()
          .describe("Restrict to one lifecycle status."),
        endUserId: endUserIdParam,
        limit: limitParam,
        offset: z.number().int().min(0).default(0),
      }),
      async execute(ctx, params) {
        const tracker = new TruncationTracker();
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
      params: z.object({ ...projectScoped, skillId: z.string().uuid() }),
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
        const [synced, definitions] = await Promise.all([
          deps.listSyncedTools(ctx.projectId, {
            includeInactive: params.includeInactive,
          }),
          deps.listToolDefinitions(ctx.projectId),
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
          },
          truncated: tracker.value,
          hint: undescribed.length
            ? "Tools listed in undescribedTools have no definition text. A tool known only by name has nothing for a prompt to match, so it can never be retrieved."
            : undefined,
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
        };
      },
    }),
  ];
}

/** Exported for tests that assert cost rounding stays stable. */
export const __testing = { round };
