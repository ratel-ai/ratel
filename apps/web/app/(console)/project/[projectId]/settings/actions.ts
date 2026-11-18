"use server";

import { revalidatePath } from "next/cache";
import { type RenameProjectResult, renameProject } from "@/lib/console/project-settings";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { updateProjectName } from "@/lib/platform/projects/queries";

/** Renames a project of any organization where the reader is an admin; the sidebar and switcher pick it up. */
export async function updateProjectNameAction(
  projectId: string,
  name: string,
): Promise<RenameProjectResult> {
  const result = await renameProject(projectId, name, {
    scope: (id) => findProjectScope(id),
    updateProjectName: (id, next) => updateProjectName(id, next),
  });
  if (result.ok) revalidatePath("/", "layout");
  return result;
}
