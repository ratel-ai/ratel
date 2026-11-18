"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { composition } from "@/lib/composition/ports";
import { deleteConsoleProject } from "@/lib/console/delete-project";
import { deleteProject, listProjectsForOrganization } from "@/lib/platform/projects/queries";
import { getSessionContext } from "@/lib/platform/session";
import { trackProductEvent } from "@/lib/platform/telemetry";

/** Deletes a project of the session organization; on success the page moves on. */
export async function deleteProjectAction(
  projectId: string,
  confirmName: string,
): Promise<{ ok: false; error: string }> {
  // The project's slug for the event, read before the delete removes it.
  let projects: Awaited<ReturnType<typeof listProjectsForOrganization>> = [];
  const result = await deleteConsoleProject(projectId, confirmName, {
    session: async () => {
      const session = await getSessionContext();
      if (!session) return null;
      projects = await listProjectsForOrganization(session.organization.id);
      return { organizationSlug: session.organization.slug, projects };
    },
    actingAs: () => composition.session.actingAs(),
    deleteProject: (id) => deleteProject(id),
    projectDeleted: async (id) => {
      const session = await getSessionContext();
      const project = projects.find((candidate) => candidate.id === id);
      if (!session || !project) return;
      await trackProductEvent(
        "project_deleted",
        { externalId: session.user.externalId, orgId: session.organization.id, projectId: id },
        { project_slug: project.slug },
      );
    },
  });
  if (!result.ok) return result;
  revalidatePath("/", "layout");
  redirect(result.next);
}
