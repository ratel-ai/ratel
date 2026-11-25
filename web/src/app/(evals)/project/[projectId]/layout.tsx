import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import ConsoleLayout from "@/app/(console)/layout";
import ProjectLayout from "@/app/(console)/project/[projectId]/layout";
import { evalsEnabledForProject } from "@/lib/views/evals/gate";

/**
 * The pages of evals: the console behind the flag. They are not in the `(console)` group: the
 * console layout streams its shell at once, and a status cannot change after that. Here the flag
 * is read above the shell, so with the flag off a page answers 404.
 */
export default async function GatedProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  if (!(await evalsEnabledForProject(projectId))) notFound();
  return (
    <ConsoleLayout>
      <ProjectLayout params={params}>{children}</ProjectLayout>
    </ConsoleLayout>
  );
}
