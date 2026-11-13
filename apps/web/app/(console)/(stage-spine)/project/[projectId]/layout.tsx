import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import ProjectLayout from "@/app/(console)/project/[projectId]/layout";
import { stageSpineEnabled } from "@/lib/views/stage-spine-flag";

/**
 * Tasks and Ship: the project layout, above the project's loading boundary, so with the
 * feature off the page answers a real 404 before anything streams.
 */
export default function GatedProjectLayout(props: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  if (!stageSpineEnabled()) notFound();
  return ProjectLayout(props);
}
