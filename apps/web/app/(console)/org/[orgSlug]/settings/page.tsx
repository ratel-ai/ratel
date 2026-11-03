import { OrgGeneralSettings } from "@/components/console/org/OrgGeneralSettings";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { composition } from "@/lib/composition";
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
  const [{ orgSlug }, ui] = await Promise.all([params, composition.ui?.()]);
  // The edition's own (rename for admins), or the read-only one.
  const General = ui?.OrganizationGeneralSettings ?? OrgGeneralSettings;
  return <General slug={orgSlug} />;
}
