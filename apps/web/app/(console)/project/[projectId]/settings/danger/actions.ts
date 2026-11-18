"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { composition } from "@/lib/composition/ports";
import { deleteConsoleProject } from "@/lib/console/delete-project";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { deleteProject, listProjectsForOrganization } from "@/lib/platform/projects/queries";

/** Deletes a project of any organization the reader belongs to; on success the page moves on. */
export async function deleteProjectAction(
  projectId: string,
  confirmName: string,
): Promise<{ ok: false; error: string }> {
  const result = await deleteConsoleProject(projectId, confirmName, {
    scope: async (id) => {
      const scope = await findProjectScope(id);
      if (!scope) return null;
      return {
        organizationSlug: scope.organization.slug,
        project: scope.project,
        projects: await listProjectsForOrganization(scope.organization.id),
      };
    },
    actingAs: () => composition.session.actingAs(),
    deleteProject: (id) => deleteProject(id),
  });
  if (!result.ok) return result;
  revalidatePath("/", "layout");
  redirect(result.next);
}
