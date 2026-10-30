"use server";

import { revalidatePath } from "next/cache";
import { type RenameProjectResult, renameProject } from "@/lib/console/project-settings";
import { getConsoleScope } from "@/lib/console/shell-data";
import { updateProjectName } from "@/lib/platform/projects/queries";

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
  });
  if (result.ok) revalidatePath("/", "layout");
  return result;
}
