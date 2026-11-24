import type { TabLink } from "@ratel/design-system/tabs";
import { organizationSettingsRoot, organizationSettingsTabs } from "@/lib/console/settings/tabs";
import type { OrgRole } from "@/lib/contracts/session";

/**
 * The organization settings tabs for this reader. Upstream's layout passes `danger: isAdmin`;
 * the Danger zone page is the edition's here, so the tab also needs the edition to have it.
 * Models (ADR-0009 §13) is the open-source edition's: the deployment's own models, after General.
 */
export function organizationSettingsTabsFor(
  slug: string,
  reader: { role: OrgRole; hasDangerPage: boolean; hasModelsPage?: boolean },
): TabLink[] {
  const tabs = organizationSettingsTabs(slug, {
    danger: reader.hasDangerPage && reader.role === "admin",
  });
  if (!reader.hasModelsPage) return tabs;
  const [general, ...rest] = tabs;
  return [general, { href: `${organizationSettingsRoot(slug)}/models`, label: "Models" }, ...rest];
}
