import { redirect } from "next/navigation";
import { movedSelfCorrectionsHref } from "@/lib/views/health/self-corrections/routes";

/** Self-corrections moved to Insights; a saved link keeps its query. */
export default async function MovedSelfCorrectionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  redirect(movedSelfCorrectionsHref(projectId, await searchParams));
}
