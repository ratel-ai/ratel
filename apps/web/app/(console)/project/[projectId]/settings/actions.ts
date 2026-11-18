"use server";

import { revalidatePath } from "next/cache";
import { type RenameProjectResult, renameProject } from "@/lib/console/project-settings";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { updateProjectName } from "@/lib/platform/projects/queries";
import { trackProductEvent } from "@/lib/platform/telemetry";

/** Renames a project of any organization where the reader is an admin; the sidebar and switcher pick it up. */
export async function updateProjectNameAction(
  projectId: string,
  name: string,
): Promise<RenameProjectResult> {
  // The project's organization and the reader, for the event.
  let scope: Awaited<ReturnType<typeof findProjectScope>> = null;
  const result = await renameProject(projectId, name, {
    scope: async (id) => {
      scope = await findProjectScope(id);
      return scope;
    },
    updateProjectName: (id, next) => updateProjectName(id, next),
    projectRenamed: async (id) => {
      if (!scope) return;
      await trackProductEvent(
        "project_settings_updated",
        { externalId: scope.user.externalId, orgId: scope.organization.id, projectId: id },
        { field: "name" },
      );
    },
  });
  if (result.ok) revalidatePath("/", "layout");
  return result;
}
