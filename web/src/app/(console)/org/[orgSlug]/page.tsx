import { Suspense } from "react";
import { OrgSkeleton } from "@/components/console/org/OrgSkeleton";
import { ProjectsPage } from "@/components/console/org/ProjectsPage";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { dbConfigured } from "@/lib/platform/db/request";

export const metadata = { title: "Projects" };

export default async function OrganizationProjectsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!(await dbConfigured())) {
    return (
      <DatabaseUnavailable title="Projects">
        Projects become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const [{ orgSlug }, search] = await Promise.all([params, searchParams]);
  return (
    <Suspense fallback={<OrgSkeleton variant="projects" />}>
      <ProjectsPage slug={orgSlug} searchParams={search} />
    </Suspense>
  );
}
