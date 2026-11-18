"use server";

import { revalidatePath } from "next/cache";
import { type RenameProjectResult, renameProject } from "@/lib/console/project-settings";
import { getConsoleScope } from "@/lib/console/shell-data";
import { updateProjectName } from "@/lib/platform/projects/queries";
import { getSessionContext } from "@/lib/platform/session";
import { trackProductEvent } from "@/lib/platform/telemetry";

/** Renames a project of the session organization; the sidebar and switcher pick it up. */
export async function updateProjectNameAction(
  projectId: string,
  name: string,
): Promise<RenameProjectResult> {
  const result = await renameProject(projectId, name, {
    projects: async () => {
      const scope = await getConsoleScope();
      return scope && scope.role === "admin" ? scope.projects : null;
    },
    updateProjectName: (id, next) => updateProjectName(id, next),
    projectRenamed: async (id) => {
      const session = await getSessionContext();
      if (!session) return;
      await trackProductEvent(
        "project_settings_updated",
        { externalId: session.user.externalId, orgId: session.organization.id, projectId: id },
        { field: "name" },
      );
    },
  });
  if (result.ok) revalidatePath("/", "layout");
  return result;
}
