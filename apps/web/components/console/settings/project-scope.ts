import { notFound } from "next/navigation";
import { findProject } from "@/lib/console/navigation";
import { listProjectsForOrganization } from "@/lib/platform/projects/queries";
import { getSessionContext } from "@/lib/platform/session";

/** The reader's view of one project for the settings tabs; any other organization's is a 404. */
export async function requireProjectScope(projectId: string) {
  const session = await getSessionContext();
  if (!session) notFound();
  const project = findProject(
    await listProjectsForOrganization(session.organization.id),
    projectId,
  );
  if (!project) notFound();
  return { project, organization: session.organization, role: session.role };
}
