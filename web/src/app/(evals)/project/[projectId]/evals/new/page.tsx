import { notFound, redirect } from "next/navigation";
import { evalsEnabledForProject } from "@/lib/views/evals/gate";
import { newEvalHref } from "@/lib/views/evals/paths";

export const dynamic = "force-dynamic";
export const metadata = { title: "New eval" };

/** The old address of the new-eval page: the Evals page with the "New eval" dialog open. */
export default async function NewEvalPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  // Next renders a page next to its layout: the layout's 404 does not stop this.
  if (!(await evalsEnabledForProject(projectId))) notFound();
  redirect(newEvalHref(projectId));
}
