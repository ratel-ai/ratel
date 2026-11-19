import { organizationRoot, projectRoot } from "@/lib/console/navigation";
import type { ActingAs } from "@/lib/contracts/session";
import { SUPPORT_SESSION_RESTRICTED_MESSAGE } from "@/lib/platform/api-key-actions";

export type DeleteProjectResult = { ok: true; next: string } | { ok: false; error: string };

export type DeleteProjectDeps = {
  /**
   * The project as this reader sees it (`findProjectScope`: any organization they belong to), with
   * its own organization's slug and projects; null without a session or for any other project.
   */
  scope: (projectId: string) => Promise<{
    organizationSlug: string;
    project: { id: string; name: string };
    projects: { id: string; name: string }[];
  } | null>;
  /** The session port's support session; any value refuses the delete, as upstream. */
  actingAs: () => Promise<ActingAs>;
  deleteProject: (projectId: string) => Promise<void>;
  /** Reports the delete (upstream's `project_deleted`), after it happened. */
  projectDeleted?: (projectId: string) => Promise<void>;
};

/**
 * Deletes a project of any organization the reader belongs to once its name is typed back, as
 * upstream. Answers where to go next: another project's Dashboards in that organization (upstream's
 * `deleteProjectAction`), or its projects page when none is left.
 */
export async function deleteConsoleProject(
  projectId: string,
  confirmName: string,
  deps: DeleteProjectDeps,
): Promise<DeleteProjectResult> {
  if (await deps.actingAs()) return { ok: false, error: SUPPORT_SESSION_RESTRICTED_MESSAGE };
  const scope = await deps.scope(projectId);
  if (!scope) return { ok: false, error: "Project not found." };
  const { project } = scope;
  if (confirmName.trim() !== project.name) {
    return { ok: false, error: "The name you typed doesn't match this project." };
  }
  await deps.deleteProject(project.id);
  await deps.projectDeleted?.(project.id);
  const remaining = scope.projects.find((candidate) => candidate.id !== project.id);
  return {
    ok: true,
    next: remaining
      ? `${projectRoot(remaining.id)}/dashboards`
      : organizationRoot(scope.organizationSlug),
  };
}
