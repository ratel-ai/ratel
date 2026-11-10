import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { findProject } from "@/lib/console/navigation";
import { getConsoleScope } from "@/lib/console/shell-data";
import { isDbConfigured } from "@/lib/platform/db/client";

/**
 * Fails closed: a project outside the session organization is a 404, never a page. Without a
 * database there is nothing to guard, and each page renders its own no-database state.
 */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  if (!isDbConfigured()) return children;

  const { projectId } = await params;
  const scope = await getConsoleScope();
  if (!findProject(scope?.projects ?? [], projectId)) notFound();
  return children;
}
