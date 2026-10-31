import { redirect } from "next/navigation";

/**
 * Intent extraction was removed. The route stays as a redirect so a bookmark, or a link pasted
 * into a ticket, lands on Intents instead of a 404. Owned (ADR-0030): there is no improvement
 * index in this edition, so the landing page is Intents itself.
 */
export default async function IntentExtractionPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/project/${encodeURIComponent(projectId)}/intents`);
}
