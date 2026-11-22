import { redirect } from "next/navigation";
import { RepositorySettings } from "@/components/console/code-handoff/RepositorySettings";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Repository" };

/**
 * RC-914: the GitHub repo linked to this project. Owned (ADR-0030): the project comes from the
 * console scope.
 */
export default async function ProjectRepositoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Settings">
        Settings become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const session = await getSessionContext();
  if (!session) redirect("/");
  const { projectId } = await params;
  const scope = await requireProjectScope(projectId);
  const query = await searchParams;
  return (
    <RepositorySettings
      session={session}
      projectId={scope.project.id}
      grant={typeof query.grant === "string" ? query.grant : null}
      setupError={typeof query.github_setup_error === "string" ? query.github_setup_error : null}
    />
  );
}
