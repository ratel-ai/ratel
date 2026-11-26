import { cache } from "react";
import { ensureSampleProject } from "@/lib/console/onboarding/provision-sample";
import { dbConfigured } from "@/lib/platform/db/request";
import type { OrgRole } from "@/lib/platform/organization";
import {
  listProjectsForOrganization,
  listProjectsForOrganizations,
} from "@/lib/platform/projects/queries";
import type { Project } from "@/lib/platform/projects/schema";
import { getSessionContext, type SessionContext } from "@/lib/platform/session";

export type ConsoleProject = {
  id: string;
  name: string;
  organizationId: string;
  slug: string;
  isDemo: boolean;
};

export type ConsoleAccount = {
  name: string;
  email: string | null;
  /** The profile photo the session carries (`SessionUser.avatarUrl`); initials without one. */
  imageUrl: string | null;
  /** A line under the name and email in the account menu (`EditionUi.accountNote`). */
  note?: string | null;
};

/** An organization the reader belongs to, with their role there. */
export type ConsoleOrganization = { id: string; name: string; slug: string; role: OrgRole };

export type ConsoleScope = {
  organizationName: string;
  organizationSlug: string;
  role: OrgRole;
  account: ConsoleAccount;
  /** The session organization's projects, oldest first. */
  projects: ConsoleProject[];
  /** Every organization the reader belongs to, in membership order (upstream's navigation data). */
  organizations: ConsoleOrganization[];
  /**
   * The projects of every organization the reader belongs to, grouped by organization in
   * membership order, oldest first within each: the ones the shell may name. With one membership
   * (open source) the same list as `projects`, read once.
   */
  memberProjects: ConsoleProject[];
};

export type ConsoleScopeDeps = {
  listProjects(organizationId: string): Promise<Project[]>;
  listProjectsForOrganizations(organizationIds: readonly string[]): Promise<Project[]>;
  ensureSampleProject: typeof ensureSampleProject;
};

const toConsoleProject = ({ id, name, organizationId, slug, isDemo }: Project): ConsoleProject => ({
  id,
  name,
  organizationId,
  slug,
  isDemo,
});

/**
 * The session organization and its projects, and every organization the reader belongs to with
 * theirs, once per request (React `cache`), shared by the shell and the pages. Null without a
 * database or a session.
 */
export const getConsoleScope = cache(async (): Promise<ConsoleScope | null> => {
  if (!(await dbConfigured())) return null;
  const context = await getSessionContext();
  if (!context) return null;
  return loadConsoleScope(context, {
    listProjects: (id) => listProjectsForOrganization(id),
    listProjectsForOrganizations: (ids) => listProjectsForOrganizations(ids),
    ensureSampleProject,
  });
});

/** The scope for one session; `getConsoleScope` with its reads handed in. */
export async function loadConsoleScope(
  context: SessionContext,
  deps: ConsoleScopeDeps,
): Promise<ConsoleScope> {
  const active = context.organization.id;
  const others = context.memberships
    .map(({ organization }) => organization.id)
    .filter((id) => id !== active);
  const [activeProjects, otherProjects] = await Promise.all([
    deps.listProjects(active),
    others.length > 0 ? deps.listProjectsForOrganizations(others) : Promise.resolve([]),
  ]);
  let projects = activeProjects;
  // An empty organization gets the sample project here, so its very first render already has
  // something to read; the provisioner seeds once per organization and never blocks the visit.
  if (projects.length === 0) {
    const seeded = await deps.ensureSampleProject({
      organization: context.organization,
      externalId: context.user.externalId,
    });
    if (seeded) projects = await deps.listProjects(active);
  }
  const byOrganization = (id: string) =>
    (id === active ? projects : otherProjects.filter((p) => p.organizationId === id)).map(
      toConsoleProject,
    );
  return {
    organizationName: context.organization.name,
    organizationSlug: context.organization.slug,
    role: context.role,
    account: {
      // Upstream's ShellV2: an empty name is no name.
      name: context.user.name || context.user.username || context.user.email || "Account",
      email: context.user.email,
      imageUrl: context.user.avatarUrl || null,
    },
    projects: projects.map(toConsoleProject),
    organizations: context.memberships.map(({ organization, role }) => ({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      role,
    })),
    memberProjects: context.memberships.flatMap(({ organization }) =>
      byOrganization(organization.id),
    ),
  };
}
