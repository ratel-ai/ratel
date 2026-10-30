import { ProjectsPage } from "@/components/console/org/ProjectsPage";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { isDbConfigured } from "@/lib/platform/db/client";

export const metadata = { title: "Projects" };

export default async function OrganizationProjectsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Projects">
        Projects become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const [{ orgSlug }, search] = await Promise.all([params, searchParams]);
  return <ProjectsPage slug={orgSlug} searchParams={search} />;
}
