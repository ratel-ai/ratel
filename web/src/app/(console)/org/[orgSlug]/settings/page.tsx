import { Suspense } from "react";
import { OrgGeneralSettings } from "@/components/console/org/OrgGeneralSettings";
import { OrgSkeleton } from "@/components/console/org/OrgSkeleton";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { composition } from "@/lib/composition";
import { dbConfigured } from "@/lib/platform/db/request";

export const metadata = { title: "Organization settings" };

export default async function OrganizationSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  if (!(await dbConfigured())) {
    return (
      <DatabaseUnavailable title="Settings">
        Organization settings become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const [{ orgSlug }, ui] = await Promise.all([params, composition.ui?.()]);
  // The edition's own (rename for admins), or the read-only one.
  const General = ui?.OrganizationGeneralSettings ?? OrgGeneralSettings;
  return (
    <Suspense fallback={<OrgSkeleton variant="settings" body />}>
      <General slug={orgSlug} />
    </Suspense>
  );
}
