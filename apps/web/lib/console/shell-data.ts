import { cache } from "react";
import { isDbConfigured } from "@/lib/platform/db/client";
import { listProjectsForOrganization } from "@/lib/platform/projects/queries";
import { getSessionContext } from "@/lib/platform/session";

export type ConsoleProject = { id: string; name: string };

export type ConsoleScope = {
  organizationName: string;
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
    projects: projects.map(({ id, name }) => ({ id, name })),
  };
});
