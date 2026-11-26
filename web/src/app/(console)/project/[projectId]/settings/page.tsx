import { GeneralSettings } from "@/components/console/settings/GeneralSettings";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { composition } from "@/lib/composition";
import { dbConfigured } from "@/lib/platform/db/request";

export const metadata = { title: "Project settings" };

export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  if (!(await dbConfigured())) {
    return (
      <DatabaseUnavailable title="Settings">
        Settings become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const [{ projectId }, ui] = await Promise.all([params, composition.ui?.()]);
  const EditionSettings = ui?.ProjectGeneralSettings;
  return (
    <GeneralSettings projectId={projectId}>
      {EditionSettings ? <EditionSettings projectId={projectId} /> : null}
    </GeneralSettings>
  );
}
