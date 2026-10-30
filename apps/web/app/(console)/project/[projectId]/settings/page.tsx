import { GeneralSettings } from "@/components/console/settings/GeneralSettings";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { isDbConfigured } from "@/lib/platform/db/client";

export const metadata = { title: "Project settings" };

export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Settings">
        Settings become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const { projectId } = await params;
  return <GeneralSettings projectId={projectId} />;
}
