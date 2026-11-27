import type { TabLink } from "@ratel/design-system/tabs";
import { organizationSettingsRoot, organizationSettingsTabs } from "@/lib/console/settings/tabs";
import type { OrgRole } from "@/lib/contracts/session";

/**
 * The organization settings tabs for this reader. Upstream's layout passes `danger: isAdmin`;
 * the Danger zone page is the edition's here, so the tab also needs the edition to have it. Slack
 * shows to those who may configure the organization's app (`slackAppAdmin`).
 */
export function organizationSettingsTabsFor(
  slug: string,
  reader: { role: OrgRole; hasDangerPage: boolean; slackApp: boolean },
): TabLink[] {
  const [general, ...rest] = organizationSettingsTabs(slug, {
    danger: reader.hasDangerPage && reader.role === "admin",
  });
  if (!reader.slackApp) return [general, ...rest];
  return [general, { href: `${organizationSettingsRoot(slug)}/slack`, label: "Slack" }, ...rest];
}
