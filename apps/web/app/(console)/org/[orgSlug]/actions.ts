"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createConsoleProject } from "@/lib/console/create-project";
import { projectRoot } from "@/lib/console/navigation";
import { createProject, listProjectsForOrganization } from "@/lib/platform/projects/queries";
import { getSessionContext } from "@/lib/platform/session";

/** Creates a project in the session organization and opens it; returns the error otherwise. */
export async function createProjectAction(
  organizationSlug: string,
  name: string,
): Promise<{ error: string }> {
  const result = await createConsoleProject(organizationSlug, name, {
    organization: async () => (await getSessionContext())?.organization ?? null,
    listProjects: (organizationId) => listProjectsForOrganization(organizationId),
    createProject: (input) => createProject(input),
  });
  if (!result.ok) return { error: result.error };
  revalidatePath("/", "layout");
  redirect(projectRoot(result.projectId));
}
