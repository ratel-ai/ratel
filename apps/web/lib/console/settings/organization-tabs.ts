import type { TabLink } from "@ratel/design-system/tabs";
import { organizationSettingsTabs } from "@/lib/console/settings/tabs";
import type { OrgRole } from "@/lib/contracts/session";

/**
 * The organization settings tabs for this reader. Upstream's layout passes `danger: isAdmin`;
 * the Danger zone page is the edition's here, so the tab also needs the edition to have it.
 */
export function organizationSettingsTabsFor(
  slug: string,
  reader: { role: OrgRole; hasDangerPage: boolean },
): TabLink[] {
  return organizationSettingsTabs(slug, {
    danger: reader.hasDangerPage && reader.role === "admin",
  });
}
