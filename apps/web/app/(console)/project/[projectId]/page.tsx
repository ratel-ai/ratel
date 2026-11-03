import { OverviewPage } from "@/components/console/home/OverviewPage";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";

export const metadata = { title: "Project home" };

/**
 * A project's home: the Overview.
 *
 * Owned (ADR-0030): the project comes from the console scope (the session's
 * organization, a 404 otherwise). No guided tour and no support session here.
 */
export default async function ProjectHomePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Overview">
        Project data becomes available once setup finishes.
      </DatabaseUnavailable>
    );
  }

  const { projectId } = await params;
  const { project, organization } = await requireProjectScope(projectId);
  return (
    <OverviewPage
      project={project}
      organization={organization}
      range={(await searchParams).range}
    />
  );
}
