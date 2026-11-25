import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import ProjectLayout from "@/app/(console)/project/[projectId]/layout";
import { sandboxesEnabledForProject } from "@/lib/views/sandboxes/gate";

/**
 * The Ratel sandbox page: the project layout behind the flag. With the
 * flag off the page is the not-found screen.
 */
export default async function GatedProjectLayout(props: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await props.params;
  if (!(await sandboxesEnabledForProject(projectId))) notFound();
  return ProjectLayout(props);
}
