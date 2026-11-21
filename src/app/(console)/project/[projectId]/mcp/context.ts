import { notFound, redirect } from "next/navigation";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import type { Organization } from "@/lib/platform/organizations";
import type { Project } from "@/lib/platform/projects/schema";
import { getSessionContext } from "@/lib/platform/session";
import { type ResolvedRange, resolveRange } from "@/lib/synthesis/dashboard";
import { MCP_ENVIRONMENT_PARAM, type McpServersQuery } from "@/lib/views/mcp-servers/paths";
import type { McpServerWindow } from "@/lib/views/mcp-servers/queries";
import { projectEntitiesEnabled } from "@/lib/views/project-entities/flag";

export type McpSearchParams = Record<string, string | string[] | undefined>;

export interface McpPageContext {
  project: Project;
  organization: Organization;
  externalId: string;
  range: ResolvedRange;
  environment: string | null;
  window: McpServerWindow;
  /** What every link of the page keeps: the window and the environment. */
  query: McpServersQuery;
}

/** What the context reads, injectable for the flag test (as the Agents context). */
export interface McpPageDeps {
  getSessionContext: () => Promise<{ user: { id: string; externalId: string } } | null>;
  getProjectScope: (
    projectId: string,
    userId: string,
  ) => Promise<{ project: Project; organization: Organization }>;
  projectEntitiesEnabled: (organization: Organization) => Promise<boolean>;
}

const defaultMcpPageDeps: McpPageDeps = {
  getSessionContext,
  getProjectScope,
  projectEntitiesEnabled,
};

/**
 * What both MCP servers pages (RC-777) start from: the signed-in person's
 * project, the flag (`FF_AGENTS_PAGES`; off, the pages do not exist),
 * the window (`range`, `from`, `to`, 30 days by default) and the environment.
 */
export async function resolveMcpPageContext(
  projectId: string,
  searchParams: McpSearchParams,
  deps: McpPageDeps = defaultMcpPageDeps,
): Promise<McpPageContext> {
  const session = await deps.getSessionContext();
  if (!session) redirect("/");
  const { project, organization } = await deps.getProjectScope(projectId, session.user.id);
  if (!(await deps.projectEntitiesEnabled(organization))) notFound();

  const range = resolveRange({
    range: text(searchParams.range),
    from: text(searchParams.from),
    to: text(searchParams.to),
  });
  const environment = text(searchParams[MCP_ENVIRONMENT_PARAM])?.trim() || null;
  return {
    project,
    organization,
    externalId: session.user.externalId,
    range,
    environment,
    window: { since: range.since, until: range.until, environment },
    query: {
      range: range.preset,
      ...(range.preset === "custom" ? { from: range.from, to: range.to } : {}),
      environment,
    },
  };
}

function text(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
