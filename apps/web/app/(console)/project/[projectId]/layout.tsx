import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { findProject } from "@/lib/console/navigation";
import { getConsoleScope } from "@/lib/console/shell-data";

/** Fails closed: a project outside the session organization is a 404, never a page. */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const scope = await getConsoleScope();
  if (!findProject(scope?.projects ?? [], projectId)) notFound();
  return children;
}
