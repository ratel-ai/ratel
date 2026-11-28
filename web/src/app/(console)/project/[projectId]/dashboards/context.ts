import { findProjectScope, type ProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";

/** The reader's project, or null where no database is connected. The project layout already guarded the id. */
export async function dashboardsScope(projectId: string): Promise<ProjectScope | null> {
  return isDbConfigured() ? findProjectScope(projectId) : null;
}
