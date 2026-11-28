import { notFound, redirect } from "next/navigation";
import { evalsEnabledForProject } from "@/lib/views/evals/gate";
import { suiteHref } from "@/lib/views/evals/paths";

export const dynamic = "force-dynamic";

/**
 * The old comparison page. The suite table of the run shows its deltas against the baseline now
 * (decision `suite-table`), so the address leads there.
 */
export default async function ComparePage({
  params,
}: {
  params: Promise<{ projectId: string; experimentId: string }>;
}) {
  const { projectId, experimentId } = await params;
  // Next renders a page next to its layout: the layout's 404 does not stop this.
  if (!(await evalsEnabledForProject(projectId))) notFound();
  redirect(suiteHref(projectId, experimentId));
}
