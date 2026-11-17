import type { ReactNode } from "react";
import ProjectLayout from "@/app/(console)/project/[projectId]/layout";

/**
 * Session replay sits in a route group of its own, so it takes the project layout here. It was
 * the place a switched-off replay answered a 404; upstream reads session replay for everyone
 * since #417, and so does this edition.
 */
export default function SessionReplayProjectLayout(props: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  return ProjectLayout(props);
}
