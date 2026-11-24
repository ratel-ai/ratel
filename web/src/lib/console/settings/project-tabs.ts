import type { TabLink } from "@ratel/design-system/tabs";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { projectSettingsRoot, projectSettingsTabs } from "@/lib/console/settings/tabs";
import { featureEnabled } from "@/lib/platform/experimental-features";

export interface ProjectTabsDeps {
  findProjectScope: typeof findProjectScope;
  featureEnabled: typeof featureEnabled;
}

/** The project settings tabs (`tabs.ts`, a sync copy), with Notifications while Alerts is on. */
export async function projectTabs(
  projectId: string,
  deps: ProjectTabsDeps = { findProjectScope, featureEnabled },
): Promise<TabLink[]> {
  const tabs = projectSettingsTabs(projectId);
  const scope = await deps.findProjectScope(projectId);
  const on =
    scope !== null &&
    (await deps.featureEnabled("alerts", {
      projectId: scope.project.id,
      organizationId: scope.organization.id,
      actor: scope.user.externalId,
    }));
  if (!on) return tabs;
  const root = projectSettingsRoot(projectId);
  const notifications = { href: `${root}/notifications`, label: "Notifications" };
  return tabs.flatMap((tab) => (tab.href === `${root}/api-keys` ? [tab, notifications] : [tab]));
}
