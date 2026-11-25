import type { TabLink } from "@ratel/design-system/tabs";
import { projectSettingsRoot, projectSettingsTabs } from "@/lib/console/settings/tabs";

/** The project settings tabs (`tabs.ts`, a sync copy) with Notifications. */
export function projectTabs(projectId: string): TabLink[] {
  const root = projectSettingsRoot(projectId);
  const notifications = { href: `${root}/notifications`, label: "Notifications" };
  return projectSettingsTabs(projectId).flatMap((tab) =>
    tab.href === `${root}/api-keys` ? [tab, notifications] : [tab],
  );
}
