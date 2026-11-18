"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { composition } from "@/lib/composition/ports";
import { deleteConsoleProject } from "@/lib/console/delete-project";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { deleteProject, listProjectsForOrganization } from "@/lib/platform/projects/queries";
import { trackProductEvent } from "@/lib/platform/telemetry";

/** Deletes a project of any organization the reader belongs to; on success the page moves on. */
export async function deleteProjectAction(
  projectId: string,
  confirmName: string,
): Promise<{ ok: false; error: string }> {
  // The project's organization, the reader and the project's slug for the event, read before the
  // delete removes it.
  let scope: Awaited<ReturnType<typeof findProjectScope>> = null;
  let projects: Awaited<ReturnType<typeof listProjectsForOrganization>> = [];
  const result = await deleteConsoleProject(projectId, confirmName, {
    scope: async (id) => {
      const found = await findProjectScope(id);
      if (!found) return null;
      scope = found;
      projects = await listProjectsForOrganization(found.organization.id);
      return { organizationSlug: found.organization.slug, project: found.project, projects };
    },
    actingAs: () => composition.session.actingAs(),
    deleteProject: (id) => deleteProject(id),
    projectDeleted: async (id) => {
      const project = projects.find((candidate) => candidate.id === id);
      if (!scope || !project) return;
      await trackProductEvent(
        "project_deleted",
        { externalId: scope.user.externalId, orgId: scope.organization.id, projectId: id },
        { project_slug: project.slug },
      );
    },
  });
  if (!result.ok) return result;
  revalidatePath("/", "layout");
  redirect(result.next);
}
