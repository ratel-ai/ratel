import { OrgGeneralSettings } from "@/components/console/org/OrgGeneralSettings";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { isDbConfigured } from "@/lib/platform/db/client";

export const metadata = { title: "Organization settings" };

export default async function OrganizationSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Settings">
        Organization settings become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const { orgSlug } = await params;
  return <OrgGeneralSettings slug={orgSlug} />;
}
