import { findProject } from "@/lib/console/navigation";
import type { ConsoleProject } from "@/lib/console/shell-data";
import { normalizeProjectName } from "@/lib/platform/projects/names";

export type RenameProjectResult = { ok: true; name: string } | { ok: false; error: string };

export type RenameProjectDeps = {
  /** The session organization's projects; null without a session. */
  projects: () => Promise<ConsoleProject[] | null>;
  updateProjectName: (projectId: string, name: string) => Promise<void>;
};

/** Renames a project of the session organization; any other id is refused before a write. */
export async function renameProject(
  projectId: string,
  name: string,
  deps: RenameProjectDeps,
): Promise<RenameProjectResult> {
  if (!findProject((await deps.projects()) ?? [], projectId)) {
    return { ok: false, error: "Project not found." };
  }
  const normalized = normalizeProjectName(name);
  if (!normalized.ok) return normalized;
  await deps.updateProjectName(projectId, normalized.name);
  return { ok: true, name: normalized.name };
}
