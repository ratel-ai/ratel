import { findProject, organizationRoot, projectRoot } from "@/lib/console/navigation";

export type DeleteProjectResult = { ok: true; next: string } | { ok: false; error: string };

export type DeleteProjectDeps = {
  /** The session organization and its projects; null without a session. */
  session: () => Promise<{
    organizationSlug: string;
    projects: { id: string; name: string }[];
  } | null>;
  deleteProject: (projectId: string) => Promise<void>;
};

/**
 * Deletes a project of the session organization once its name is typed back. Answers where to go
 * next: another project, or the projects page when none is left.
 */
export async function deleteConsoleProject(
  projectId: string,
  confirmName: string,
  deps: DeleteProjectDeps,
): Promise<DeleteProjectResult> {
  const session = await deps.session();
  const project = findProject(session?.projects ?? [], projectId);
  if (!session || !project) return { ok: false, error: "Project not found." };
  if (confirmName.trim() !== project.name) {
    return { ok: false, error: "The name you typed doesn't match this project." };
  }
  await deps.deleteProject(project.id);
  const remaining = session.projects.find((candidate) => candidate.id !== project.id);
  return {
    ok: true,
    next: remaining ? projectRoot(remaining.id) : organizationRoot(session.organizationSlug),
  };
}
