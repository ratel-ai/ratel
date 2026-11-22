import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import ProjectLayout from "@/app/(console)/project/[projectId]/layout";
import { evalsEnabledForProject } from "@/lib/views/evals/gate";

/**
 * The Evals pages (the eval suite, its runs, scorers, a fix's page and its simulations): the
 * project layout, above the project's loading boundary, so with `FF_EVALS` off every page
 * answers a real 404 before anything streams, and the console's routes stay as they were.
 */
export default async function EvalsProjectLayout(props: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await props.params;
  if (!(await evalsEnabledForProject(projectId))) notFound();
  return ProjectLayout(props);
}
