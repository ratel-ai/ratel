import { z } from "zod";
import { MAX_DESCRIPTION } from "@/lib/catalog/manage";
import { setRuntimeCatalogOverride } from "@/lib/ingest/runtime-catalog/override-queries";
import { notFound } from "@/lib/mcp/errors";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { trackServerEvent } from "@/lib/platform/telemetry";

/**
 * Editing how a runtime-synced catalog entry is described for retrieval.
 *
 * This is the one write on the MCP surface that an `rtl_` key cannot already
 * perform over HTTP: `/api/v1/runtime-catalog/overrides` exposes GET only, and
 * the PATCH lives on the session-authenticated console route. It is included
 * deliberately, and the reasoning is worth stating rather than assuming.
 *
 * The capability is strictly smaller than what the same key already has. A
 * project key can create, rewrite, publish and archive whole skills, bodies
 * included. Setting one entry's searchable description is a subset of that
 * blast radius, scoped to the same project, and reversible by passing null.
 * Withholding it would mean an agent can rewrite the catalog but not fix the
 * one field this product exists to teach people to fix.
 *
 * If that trade is ever revisited, this file is the whole surface to remove.
 */
export interface RuntimeWriteDeps {
  setRuntimeCatalogOverride: typeof setRuntimeCatalogOverride;
  trackServerEvent: typeof trackServerEvent;
}

export const defaultRuntimeWriteDeps: RuntimeWriteDeps = {
  setRuntimeCatalogOverride,
  trackServerEvent,
};

export function runtimeWriteOperations(
  deps: RuntimeWriteDeps = defaultRuntimeWriteDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "set_catalog_override",
      domain: "writes",
      title: "Override a catalog entry's searchable description",
      description:
        "Replace the searchable description of one runtime-synced catalog entry, which is the text retrieval matches against. Use it to make a tool findable when the runtime's own description is thin or absent. Pass null to clear the override and fall back to what the runtime reported. Does not change the description the agent reads.",
      keywords: ["override", "override tool description", "make findable", "tool"],
      scope: "project",
      mutates: true,
      params: z.object({
        ...projectScoped,
        kind: z
          .enum(["tool", "skill", "fact"])
          .describe("Which catalog the entry belongs to, as reported by list_declared_tools."),
        entryId: z.string().min(1).max(512),
        searchableDescription: z
          .string()
          .max(MAX_DESCRIPTION)
          .nullable()
          .describe("The replacement text, or null to clear the override."),
      }),
      async execute(ctx, params) {
        const row = await deps.setRuntimeCatalogOverride(
          ctx.projectId,
          params.kind,
          params.entryId,
          params.searchableDescription,
        );
        // Nothing was updated, which means the runtime has never synced this
        // entry. Same answer as a foreign project's id, so this cannot be used
        // to probe which entries exist elsewhere.
        if (!row) throw notFound("runtime catalog entry");

        await deps.trackServerEvent(
          "runtime_catalog_override_updated",
          {
            projectId: ctx.projectId,
            ...(ctx.organizationId ? { orgId: ctx.organizationId } : {}),
          },
          {
            object_action: "runtime_catalog_override_updated",
            kind: params.kind,
            entry_id: params.entryId,
            cleared: params.searchableDescription === null,
            surface: "mcp",
          },
        );

        return {
          data: {
            kind: params.kind,
            entryId: params.entryId,
            searchableDescription: row.searchableDescriptionOverride,
          },
          hint: "Retrieval picks this up on the next catalog rebuild; list_catalog_overrides shows what is currently set.",
        };
      },
    }),
  ];
}
