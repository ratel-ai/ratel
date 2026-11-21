import { notFound, redirect } from "next/navigation";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import type { Organization } from "@/lib/platform/organizations";
import type { Project } from "@/lib/platform/projects/schema";
import { getSessionContext } from "@/lib/platform/session";
import { type ResolvedRange, resolveRange } from "@/lib/synthesis/dashboard";
import type { AgentWindow } from "@/lib/views/agents/domain/types";
import {
  AGENTS_ENVIRONMENT_PARAM,
  AGENTS_SHOW_HIDDEN_PARAM,
  type AgentsQuery,
} from "@/lib/views/agents/paths";
import { projectEntitiesEnabled } from "@/lib/views/project-entities/flag";

export type AgentsSearchParams = Record<string, string | string[] | undefined>;

export interface AgentsPageContext {
  project: Project;
  organization: Organization;
  externalId: string;
  range: ResolvedRange;
  environment: string | null;
  window: AgentWindow;
  /** What every link of the page keeps: the window and the environment. */
  query: AgentsQuery;
  /** An organization admin: may rename, hide and merge agents (RC-776). */
  canEdit: boolean;
  /** `?showHidden=1`: list hidden agents too. */
  showHidden: boolean;
}

/** What the context reads, injectable for the flag test. */
export interface AgentsPageDeps {
  getSessionContext: () => Promise<{ user: { id: string; externalId: string } } | null>;
  getProjectScope: (
    projectId: string,
    userId: string,
  ) => Promise<{ project: Project; organization: Organization; role: string }>;
  projectEntitiesEnabled: (organization: Organization) => Promise<boolean>;
}

const defaultAgentsPageDeps: AgentsPageDeps = {
  getSessionContext,
  getProjectScope,
  projectEntitiesEnabled,
};

/**
 * What both Agents pages (RC-775) start from: the signed-in person's
 * project, the flag (`FF_AGENTS_PAGES`; off, the pages do not exist),
 * the window (`range`, `from`, `to`, 30 days by default) and the environment.
 */
export async function resolveAgentsPageContext(
  projectId: string,
  searchParams: AgentsSearchParams,
  deps: AgentsPageDeps = defaultAgentsPageDeps,
): Promise<AgentsPageContext> {
  const session = await deps.getSessionContext();
  if (!session) redirect("/");
  const { project, organization, role } = await deps.getProjectScope(projectId, session.user.id);
  if (!(await deps.projectEntitiesEnabled(organization))) notFound();

  const range = resolveRange({
    range: text(searchParams.range),
    from: text(searchParams.from),
    to: text(searchParams.to),
  });
  const environment = text(searchParams[AGENTS_ENVIRONMENT_PARAM])?.trim() || null;
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
    canEdit: role === "admin",
    showHidden: text(searchParams[AGENTS_SHOW_HIDDEN_PARAM]) === "1",
  };
}

function text(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
