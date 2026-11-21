import { ApiKeysSettings } from "@/components/console/settings/ApiKeysSettings";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { isDbConfigured } from "@/lib/platform/db/client";

export const metadata = { title: "API keys" };

export default async function ScopedApiKeysPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Settings">
        API keys become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const { projectId } = await params;
  return <ApiKeysSettings projectId={projectId} />;
}
