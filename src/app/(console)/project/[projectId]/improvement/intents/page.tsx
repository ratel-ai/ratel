import { redirect } from "next/navigation";

/**
 * Intent extraction was removed. The route stays as a redirect so a bookmark, or a
 * link pasted into a ticket, lands on the section index instead of a 404.
 */
export default async function IntentExtractionPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/project/${encodeURIComponent(projectId)}/improvement`);
}
