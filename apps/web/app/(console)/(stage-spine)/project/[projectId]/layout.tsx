import type { ReactNode } from "react";
import ProjectLayout from "@/app/(console)/project/[projectId]/layout";

/**
 * Tasks and Ship: the project layout, above the project's loading boundary. The route group
 * keeps the upstream pages' own folder; the stage rail is on for everyone, as upstream (RC-270).
 */
export default function StageProjectLayout(props: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  return ProjectLayout(props);
}
