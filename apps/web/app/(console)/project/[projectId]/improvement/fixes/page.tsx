import { redirect } from "next/navigation";

/**
 * Where a fix is made. The Fixes page is not part of this build yet, so the links the health
 * cards, Tasks and Self-corrections carry lead to the Agent health summary, where each fix's
 * issue is listed. A temporary redirect: the page lands under this path.
 */
export default async function FixesRedirectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/project/${encodeURIComponent(projectId)}/health`);
}
