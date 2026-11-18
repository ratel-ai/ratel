import { normalizeProjectName } from "@/lib/platform/projects/names";

export type RenameProjectResult = { ok: true; name: string } | { ok: false; error: string };

export type RenameProjectDeps = {
  /**
   * The project as this reader sees it (`findProjectScope`): any organization they belong to, with
   * their role there; null without a session or for a project of another organization.
   */
  scope: (projectId: string) => Promise<{ project: { id: string }; role: string } | null>;
  updateProjectName: (projectId: string, name: string) => Promise<void>;
};

/**
 * Renames a project of an organization where the reader is an admin, active or not, as upstream;
 * any other id is refused before a write.
 */
export async function renameProject(
  projectId: string,
  name: string,
  deps: RenameProjectDeps,
): Promise<RenameProjectResult> {
  const scope = await deps.scope(projectId);
  if (!scope || scope.role !== "admin") return { ok: false, error: "Project not found." };
  const normalized = normalizeProjectName(name);
  if (!normalized.ok) return normalized;
  await deps.updateProjectName(scope.project.id, normalized.name);
  return { ok: true, name: normalized.name };
}
