import { DangerSettings } from "@/components/console/settings/DangerSettings";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { dbConfigured } from "@/lib/platform/db/request";

export const metadata = { title: "Danger zone" };

export default async function ScopedProjectDangerPage({
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
  const { projectId } = await params;
  return <DangerSettings projectId={projectId} />;
}
