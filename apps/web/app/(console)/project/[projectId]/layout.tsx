import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { RememberProject } from "@/components/console/shell/RememberProject";
import { findProject } from "@/lib/console/navigation";
import { LAST_PROJECT_COOKIE } from "@/lib/console/scope/cookie";
import { lastProjectDiffers } from "@/lib/console/scope/remember-project";
import { getConsoleScope } from "@/lib/console/shell-data";
import { isDbConfigured } from "@/lib/platform/db/client";

/**
 * Fails closed: a project outside the session organization is a 404, never a page. Without a
 * database there is nothing to guard, and each page renders its own no-database state.
 *
 * A layout cannot set a cookie, so when the last-project cookie names another project the layout
 * renders `RememberProject`, whose server action writes it: upstream's proxy does this as it
 * serves the page, with the same only-when-it-changes rule.
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
  const remembered = (await cookies()).get(LAST_PROJECT_COOKIE)?.value;
  return (
    <>
      {lastProjectDiffers(remembered, projectId) ? <RememberProject projectId={projectId} /> : null}
      {children}
    </>
  );
}
