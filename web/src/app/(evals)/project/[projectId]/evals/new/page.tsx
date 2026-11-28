import { notFound, redirect } from "next/navigation";
import { EvalView } from "@/components/console/evals/EvalView";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { evalsEnabledForProject } from "@/lib/views/evals/gate";

export const dynamic = "force-dynamic";
export const metadata = { title: "New eval" };

/** A new eval: its definition. Its dataset fills from traces, runs and new cases. */
export default async function NewEvalPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  // Next renders a page next to its layout: the layout's 404 does not stop this.
  if (!(await evalsEnabledForProject(projectId))) notFound();
  if (!(await getSessionContext())) redirect("/");
  const { project } = await getProjectScope(projectId);
  if (await isRestrictedBySupportSession()) notFound();
  return <EvalView model={{ projectId: project.id }} canEdit />;
}
