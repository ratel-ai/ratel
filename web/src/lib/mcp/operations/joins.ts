import { z } from "zod";
import { listSkills } from "@/lib/catalog/queries";
import {
  listSearchQueriesForSkillHit,
  listSkillsSearchedButNeverInvoked,
  listTopErroringTools,
  listTopSearchQueries,
} from "@/lib/ingest/trace-events/queries";
import { endUserIdParam, projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { capRows, limitParam, TruncationTracker } from "@/lib/mcp/serialize";
import { resolveWindow, WINDOW_PRESETS, windowParams } from "@/lib/mcp/windows";

/**
 * Cross-surface answers, shipped as named operations.
 *
 * These join catalog data against telemetry. Exposing the underlying tables and
 * letting the agent compose the join itself produces confident, wrong answers:
 * the joins are non-obvious (a skill that was searched is not the same as one
 * that was invoked) and a plausible mistake is indistinguishable from a real
 * finding. Shipping the joins the console already validates means the agent
 * gets the answer the product stands behind.
 */
export interface JoinsOperationDeps {
  listSkillsSearchedButNeverInvoked: typeof listSkillsSearchedButNeverInvoked;
  listTopSearchQueries: typeof listTopSearchQueries;
  listTopErroringTools: typeof listTopErroringTools;
  listSearchQueriesForSkillHit: typeof listSearchQueriesForSkillHit;
  listSkills: typeof listSkills;
}

export const defaultJoinsDeps: JoinsOperationDeps = {
  listSkillsSearchedButNeverInvoked,
  listTopSearchQueries,
  listTopErroringTools,
  listSearchQueriesForSkillHit,
  listSkills,
};

export function joinsOperations(deps: JoinsOperationDeps = defaultJoinsDeps): McpOperation[] {
  return [
    defineOperation({
      id: "get_improvement_signals",
      domain: "joins",
      title: "What to fix",
      description:
        "The single best starting point for improving a catalog: skills that get retrieved in search but never actually invoked, the most common user queries, and the tools erroring most often.",
      keywords: [
        "what should i fix",
        "improve",
        "never retrieved",
        "never invoked",
        "unused",
        "wasted",
      ],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        ...windowParams,
        endUserId: endUserIdParam,
        limit: limitParam,
      }),
      async execute(ctx, params) {
        const window = resolveWindow(params, WINDOW_PRESETS.aggregates);
        const tracker = new TruncationTracker();
        const options = { endUserId: params.endUserId };

        const [neverInvoked, topQueries, erroringTools, skills] = await Promise.all([
          deps.listSkillsSearchedButNeverInvoked(ctx.projectId, options),
          deps.listTopSearchQueries(ctx.projectId, {
            since: window.since,
            limit: params.limit,
            endUserId: params.endUserId,
          }),
          deps.listTopErroringTools(ctx.projectId, {
            since: window.since,
            limit: params.limit,
            endUserId: params.endUserId,
          }),
          // Catalog rows, to resolve each runtime identifier back to a stored
          // skill so the agent can follow up without a second lookup.
          deps.listSkills(ctx.projectId, { limit: 500 }),
        ]);

        // Trace-event hits identify a skill by the name the runtime used
        // (`trace_event_hits.target_id`), not by the catalog's UUID. Joining on
        // id would silently match nothing and report every skill as unknown,
        // so this keys by name.
        const catalogByName = new Map(skills.map((skill) => [skill.name, skill]));
        const neverInvokedPage = tracker.take(capRows(neverInvoked, params.limit));

        return {
          data: {
            searchedButNeverInvoked: neverInvokedPage.map((row) => {
              const catalogSkill = catalogByName.get(row.skillId);
              return {
                skillName: row.skillId,
                // Null means the runtime searched for a skill this catalog
                // does not define, which is itself a finding.
                skillId: catalogSkill?.id ?? null,
                status: catalogSkill?.status ?? null,
                searchAppearances: row.searchAppearances,
              };
            }),
            topSearchQueries: topQueries,
            topErroringTools: erroringTools,
          },
          truncated: tracker.value,
          window: window.toJSON(),
          hint: "A skill that appears in search but is never invoked usually has a description that matches the wrong queries. list_search_queries_for_skill shows which ones.",
        };
      },
    }),
    defineOperation({
      id: "list_search_queries_for_skill",
      domain: "joins",
      title: "Queries that retrieved a skill",
      description:
        "The real user queries that caused a given skill to be retrieved. The fastest way to see whether a skill's description is matching the intent you meant it to. Identify the skill by name, as the runtime does.",
      keywords: ["queries that retrieved a skill", "why retrieved", "matched", "skill"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        // Retrieval telemetry records the name the runtime asked for, not the
        // catalog UUID, so a UUID here would match nothing. `list_skills` and
        // `get_improvement_signals` both surface the name to pass in.
        skillName: z
          .string()
          .min(1)
          .max(200)
          .describe("The skill's name, as it appears in the catalog and in retrieval telemetry."),
        endUserId: endUserIdParam,
        limit: limitParam,
      }),
      async execute(ctx, params) {
        const tracker = new TruncationTracker();
        const queries = await deps.listSearchQueriesForSkillHit(
          ctx.projectId,
          params.skillName,
          params.limit,
          { endUserId: params.endUserId },
        );
        return {
          data: {
            skillName: params.skillName,
            count: queries.length,
            queries: queries.map((query) => tracker.text(query, 300)),
          },
          truncated: tracker.value,
          ...(queries.length === 0
            ? {
                hint: "No retrievals recorded for that name. Check the exact name with list_skills; retrieval telemetry keys on the runtime's skill name.",
              }
            : {}),
        };
      },
    }),
  ];
}
