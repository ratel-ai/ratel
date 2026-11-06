import { z } from "zod";
import { hasProjectIngestedEvents } from "@/lib/ingest/otlp/queries";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { notFound } from "@/lib/mcp/errors";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { resolveWindow, WINDOW_PRESETS, windowParams } from "@/lib/mcp/windows";
import { getProjectById, listProjectsForOrganization } from "@/lib/platform/projects/queries";
import { getProjectHomeEntityCounts } from "@/lib/views/home/queries";

/**
 * Scope discovery: which projects this credential can reach, and what is in
 * one.
 *
 * These are the mandatory first hop. Every other operation needs a project, and
 * without these an agent has no way to obtain one except guessing a UUID.
 */
export interface ScopeOperationDeps {
  getProjectById: typeof getProjectById;
  listProjectsForOrganization: typeof listProjectsForOrganization;
  getProjectHomeEntityCounts: typeof getProjectHomeEntityCounts;
  hasProjectIngestedEvents: typeof hasProjectIngestedEvents;
}

export const defaultScopeDeps: ScopeOperationDeps = {
  getProjectById,
  listProjectsForOrganization,
  getProjectHomeEntityCounts,
  hasProjectIngestedEvents,
};

/** Shared by `whoami` (a direct tool) and the `list_projects` operation. */
export async function describeCaller(
  auth: McpAuthContext,
  deps: ScopeOperationDeps = defaultScopeDeps,
): Promise<Record<string, unknown>> {
  if (auth.kind === "oauth") {
    // A signed-in user reaches every project in every organization they belong
    // to, which is the whole reason to prefer this over a project key.
    const organizations = await Promise.all(
      auth.memberships.map(async (membership) => ({
        id: membership.organizationId,
        slug: membership.organization.slug,
        plan: membership.organization.effectivePlan,
        role: membership.role,
        projects: (await deps.listProjectsForOrganization(membership.organizationId)).map(
          (project) => ({ id: project.id, name: project.name, slug: project.slug }),
        ),
      })),
    );
    return {
      authKind: "oauth",
      organizations,
      note: "Pass projectId to choose which project a tool acts on.",
    };
  }
  const project = await deps.getProjectById(auth.projectId);
  return {
    authKind: "api-key",
    project: project
      ? { id: project.id, name: project.name, slug: project.slug }
      : { id: auth.projectId },
    organization: auth.organization
      ? {
          id: auth.organization.id,
          slug: auth.organization.slug,
          plan: auth.organization.effectivePlan,
        }
      : null,
    note: "This key is scoped to one project. Operations default to it.",
  };
}

export function scopeOperations(deps: ScopeOperationDeps = defaultScopeDeps): McpOperation[] {
  return [
    defineOperation({
      id: "list_projects",
      domain: "scope",
      title: "List projects",
      description:
        "List the projects this credential can reach, with their ids and slugs. Use the returned id as projectId for other operations.",
      keywords: ["projects", "workspace", "which project", "scope"],
      scope: "none",
      mutates: false,
      params: z.object({}),
      async execute(ctx) {
        if (ctx.auth.kind === "oauth") {
          const rows = await Promise.all(
            ctx.auth.memberships.map(async (membership) =>
              (await deps.listProjectsForOrganization(membership.organizationId)).map(
                (project) => ({
                  id: project.id,
                  name: project.name,
                  slug: project.slug,
                  organization: membership.organization.slug,
                  createdAt: project.createdAt.toISOString(),
                }),
              ),
            ),
          );
          const projects = rows.flat();
          return {
            data: { count: projects.length, projects },
            hint: "Pass one of these ids as projectId to any other tool.",
          };
        }
        const { projectId, organization } = ctx.auth;
        const siblings = organization
          ? await deps.listProjectsForOrganization(organization.id)
          : [];
        // An API key authorizes exactly one project even though its
        // organization may own several. Listing the siblings would imply
        // access this credential does not have.
        const reachable = siblings.filter((project) => project.id === projectId);
        return {
          data: {
            count: reachable.length,
            projects: reachable.map((project) => ({
              id: project.id,
              name: project.name,
              slug: project.slug,
              createdAt: project.createdAt.toISOString(),
            })),
          },
          hint: "This API key reaches one project. Sign in with OAuth to see every project you are a member of.",
        };
      },
    }),
    defineOperation({
      id: "get_project_overview",
      domain: "scope",
      title: "Project overview",
      description:
        "Counts of skills and active experiments for a project, plus whether it has ingested any telemetry yet. The best first call to orient in a project.",
      keywords: ["how many skills", "counts", "inventory", "orient", "first hop"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped, ...windowParams }),
      async execute(ctx, params) {
        const project = await deps.getProjectById(ctx.projectId);
        if (!project) throw notFound("project");

        const window = resolveWindow(params, WINDOW_PRESETS.entities);
        const [counts, hasEvents] = await Promise.all([
          deps.getProjectHomeEntityCounts(ctx.projectId, window.since, window.until),
          deps.hasProjectIngestedEvents(ctx.projectId),
        ]);

        return {
          data: {
            project: { id: project.id, name: project.name, slug: project.slug },
            hasIngestedTelemetry: hasEvents,
            counts,
          },
          window: window.toJSON(),
          hint: hasEvents
            ? "Use get_cost_by_day or get_trace_health for spend, or get_improvement_signals for what to fix."
            : "No telemetry yet. get_traces_ingest_diagnostics explains what the ingest endpoint has seen.",
        };
      },
    }),
  ];
}
