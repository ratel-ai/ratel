import { notFound, redirect } from "next/navigation";
import { evalsEnabledForProject } from "@/lib/views/evals/gate";
import { experimentHref } from "@/lib/views/evals/paths";
import { evalPage } from "./eval-pages";

export const dynamic = "force-dynamic";
export const metadata = { title: "Eval" };

/**
 * One eval: its definition, a chart of its scorers over its runs, and its runs. The old address of
 * a run on this page (`?run=`) opens that run.
 */
export default async function EvalPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; evalId: string }>;
  searchParams: Promise<{ run?: string | string[] }>;
}) {
  const [{ projectId, evalId }, query] = await Promise.all([params, searchParams]);
  // Next renders a page next to its layout: the layout's 404 does not stop this.
  if (!(await evalsEnabledForProject(projectId))) notFound();
  const runId = Array.isArray(query.run) ? query.run[0] : query.run;
  if (runId) redirect(experimentHref(projectId, runId));
  return evalPage(projectId, evalId);
}
