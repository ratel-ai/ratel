import { notFound, redirect } from "next/navigation";
import { evalsEnabledForProject } from "@/lib/views/evals/gate";
import { experimentHref } from "@/lib/views/evals/paths";

export const dynamic = "force-dynamic";

/**
 * The old comparison page. A run shows its deltas against the baseline of its eval now (decision
 * `runs-per-eval`), so the address leads to the run.
 */
export default async function ComparePage({
  params,
}: {
  params: Promise<{ projectId: string; experimentId: string }>;
}) {
  const { projectId, experimentId } = await params;
  // Next renders a page next to its layout: the layout's 404 does not stop this.
  if (!(await evalsEnabledForProject(projectId))) notFound();
  redirect(experimentHref(projectId, experimentId));
}
