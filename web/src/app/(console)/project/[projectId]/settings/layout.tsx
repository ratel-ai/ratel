import type { ReactNode } from "react";
import { SettingsFrame } from "@/components/console/settings/SettingsFrame";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { projectSettingsTabs } from "@/lib/console/settings/tabs";
import { isDbConfigured } from "@/lib/platform/db/client";
import { featureEnabled } from "@/lib/platform/experimental-features";

/**
 * Project settings share one header and its URL tabs, so a tab switch keeps
 * the header and loads only the tab. Without a database each tab says so on
 * its own page.
 */
export default async function ProjectSettingsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  if (!isDbConfigured()) return children;
  const { projectId } = await params;
  const scope = await findProjectScope(projectId);
  const notifications =
    scope !== null &&
    (await featureEnabled("alerts", {
      projectId: scope.project.id,
      organizationId: scope.organization.id,
      actor: scope.user.externalId,
    }));
  return (
    <SettingsFrame
      label="Project settings"
      tabs={projectSettingsTabs(projectId, { notifications })}
    >
      {children}
    </SettingsFrame>
  );
}
