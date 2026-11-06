"use client";

import { useParams } from "next/navigation";
import { StatusLink } from "@/components/console/errors/StatusLink";

export function ScopedTraceListLink() {
  const params = useParams<{ projectId?: string | string[] }>();
  const rawProjectId = params.projectId;
  const projectId = Array.isArray(rawProjectId) ? rawProjectId[0] : rawProjectId;
  const href = projectId ? `/project/${encodeURIComponent(projectId)}/traces` : "/organizations";

  return <StatusLink href={href}>Back to traces</StatusLink>;
}
