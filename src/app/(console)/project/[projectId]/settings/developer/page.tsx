import { DeveloperSettings } from "@/components/console/settings/DeveloperSettings";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import type { SearchParamsRecord } from "@/lib/console/settings/tabs";
import { isDbConfigured } from "@/lib/platform/db/client";

export const metadata = { title: "Developer" };

/**
 * Settings > Developer: SDK events (DESIGN.md: Runtime events become
 * Settings > Developer > SDK events). Gated like the page it replaced, which
 * now redirects here with its filters.
 */
export default async function DeveloperSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<SearchParamsRecord>;
}) {
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Settings">
        SDK events become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const [{ projectId }, search] = await Promise.all([params, searchParams]);
  return <DeveloperSettings projectId={projectId} searchParams={search} />;
}
