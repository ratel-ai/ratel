import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import ProjectLayout from "@/app/(console)/project/[projectId]/layout";
import { evalGateEnabledForProject } from "@/lib/views/eval-gate/gate";

/**
 * A fix's eval page: the project layout, above the project's loading boundary, so with the
 * feature off the page answers a real 404 before anything streams.
 */
export default async function GatedProjectLayout(props: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await props.params;
  if (!(await evalGateEnabledForProject(projectId))) notFound();
  return ProjectLayout(props);
}
