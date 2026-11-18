import { normalizeProjectName } from "@/lib/platform/projects/names";

/** Upstream's refusal for a member who is not an admin (`lib/settings/action-handlers.ts`). */
const ADMIN_PROJECT_RENAME_ERROR = "Only organization admins can rename projects.";

export type RenameProjectResult = { ok: true; name: string } | { ok: false; error: string };

export type RenameProjectDeps = {
  /**
   * The project as this reader sees it (`findProjectScope`): any organization they belong to, with
   * their role there; null without a session or for a project of another organization.
   */
  scope: (
    projectId: string,
  ) => Promise<{ project: { id: string; name: string }; role: string } | null>;
  updateProjectName: (projectId: string, name: string) => Promise<void>;
  /** Reports the rename (upstream's `project_settings_updated`); called only when the name changed. */
  projectRenamed?: (projectId: string) => Promise<void>;
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
  if (!scope) return { ok: false, error: "Project not found." };
  if (scope.role !== "admin") return { ok: false, error: ADMIN_PROJECT_RENAME_ERROR };
  const normalized = normalizeProjectName(name);
  if (!normalized.ok) return normalized;
  // Upstream writes and reports only a changed name.
  if (normalized.name !== scope.project.name) {
    await deps.updateProjectName(scope.project.id, normalized.name);
    await deps.projectRenamed?.(scope.project.id);
  }
  return { ok: true, name: normalized.name };
}
