import { cache } from "react";
import { isDbConfigured } from "@/lib/platform/db/client";
import type { OrgRole } from "@/lib/platform/organization";
import { listProjectsForOrganization } from "@/lib/platform/projects/queries";
import { getSessionContext } from "@/lib/platform/session";

export type ConsoleProject = { id: string; name: string };

export type ConsoleAccount = { name: string; email: string | null };

export type ConsoleScope = {
  organizationName: string;
  organizationSlug: string;
  role: OrgRole;
  account: ConsoleAccount;
  /** The session organization's projects, oldest first: the only ones a console route may show. */
  projects: ConsoleProject[];
};

/**
 * The session organization and its projects, once per request (React `cache`), shared by the
 * shell and the pages. Null without a database or a session.
 */
export const getConsoleScope = cache(async (): Promise<ConsoleScope | null> => {
  if (!isDbConfigured()) return null;
  const context = await getSessionContext();
  if (!context) return null;
  const projects = await listProjectsForOrganization(context.organization.id);
  return {
    organizationName: context.organization.name,
    organizationSlug: context.organization.slug,
    role: context.role,
    account: {
      name: context.user.name ?? context.user.username ?? context.user.email ?? "Operator",
      email: context.user.email,
    },
    projects: projects.map(({ id, name }) => ({ id, name })),
  };
});
