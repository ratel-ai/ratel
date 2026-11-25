import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import ProjectLayout from "@/app/(console)/project/[projectId]/layout";
import { evalsEnabledForProject } from "@/lib/views/evals/gate";

/**
 * The pages of evals: the project layout, above the project's loading boundary, so with the flag
 * off a page answers a real 404 before anything streams.
 */
export default async function GatedProjectLayout(props: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await props.params;
  if (!(await evalsEnabledForProject(projectId))) notFound();
  return ProjectLayout(props);
}
