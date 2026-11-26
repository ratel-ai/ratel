import { ApiKeysSettings } from "@/components/console/settings/ApiKeysSettings";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { dbConfigured } from "@/lib/platform/db/request";

export const metadata = { title: "API keys" };

export default async function ScopedApiKeysPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  if (!(await dbConfigured())) {
    return (
      <DatabaseUnavailable title="Settings">
        API keys become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const { projectId } = await params;
  return <ApiKeysSettings projectId={projectId} />;
}
