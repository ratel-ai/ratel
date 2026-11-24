import { permanentRedirect } from "next/navigation";
import { movedSelfCorrectionsHref } from "@/lib/views/health/self-corrections/paths";

/** Self-corrections stands in Insights now; an old link lands there, its query kept. */
export default async function MovedSelfCorrectionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  permanentRedirect(movedSelfCorrectionsHref(projectId, query));
}
