"use client";

import { useEffect } from "react";
import { rememberProjectAction } from "@/app/(console)/project/[projectId]/actions";

/**
 * Asks the server to remember the open project. The project layout renders it only while the
 * last-project cookie names another project, so the action runs once per switch, not per page.
 */
export function RememberProject({ projectId }: { projectId: string }) {
  useEffect(() => {
    void rememberProjectAction(projectId);
  }, [projectId]);
  return null;
}
