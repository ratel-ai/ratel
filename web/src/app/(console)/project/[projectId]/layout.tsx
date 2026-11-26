import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { RememberProject } from "@/components/console/shell/RememberProject";
import { composition } from "@/lib/composition/ports";
import { LAST_PROJECT_COOKIE } from "@/lib/console/scope/cookie";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { lastProjectDiffers, openProject } from "@/lib/console/scope/remember-project";
import { dbConfigured } from "@/lib/platform/db/request";

/**
 * Fails closed: a project of an organization the reader does not belong to is a 404, never a
 * page. Any organization they belong to opens, active or not, as upstream. Without a database
 * there is nothing to guard, and each page renders its own no-database state.
 *
 * Once the reader may see the project, the edition remembers it (`SessionPort.rememberProject`;
 * upstream's layout writes `users.last_project_id` here). A layout cannot set a cookie, so when
 * the last-project cookie names another project the layout renders `RememberProject`, whose server
 * action writes it: upstream's proxy does this as it serves the page, with the same
 * only-when-it-changes rule.
 */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  if (!(await dbConfigured())) return children;

  const { projectId } = await params;
  const { rememberProject } = composition.session;
  const scope = await openProject(projectId, {
    find: (id) => findProjectScope(id),
    remember: rememberProject ? (id) => rememberProject.call(composition.session, id) : undefined,
  });
  if (!scope) notFound();
  const remembered = (await cookies()).get(LAST_PROJECT_COOKIE)?.value;
  return (
    <>
      {lastProjectDiffers(remembered, projectId) ? <RememberProject projectId={projectId} /> : null}
      {children}
    </>
  );
}
