"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { deleteConsoleProject } from "@/lib/console/delete-project";
import { deleteProject, listProjectsForOrganization } from "@/lib/platform/projects/queries";
import { getSessionContext } from "@/lib/platform/session";

/** Deletes a project of the session organization; on success the page moves on. */
export async function deleteProjectAction(
  projectId: string,
  confirmName: string,
): Promise<{ ok: false; error: string }> {
  const result = await deleteConsoleProject(projectId, confirmName, {
    session: async () => {
      const session = await getSessionContext();
      if (!session) return null;
      return {
        organizationSlug: session.organization.slug,
        projects: await listProjectsForOrganization(session.organization.id),
      };
    },
    deleteProject: (id) => deleteProject(id),
  });
  if (!result.ok) return result;
  revalidatePath("/", "layout");
  redirect(result.next);
}
