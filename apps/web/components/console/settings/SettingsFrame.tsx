import { Page, PageHeader } from "@ratel/design-system/page-header";
import { type TabLink, TabNav } from "@ratel/design-system/tabs";
import type { ReactNode } from "react";

/**
 * The Settings pages' frame: one "Settings" header whose tabs
 * are URLs, then the tab. Rendered by the settings layouts, so switching tabs
 * keeps the header in place and only the tab's body loads.
 */
export function SettingsFrame({
  tabs,
  label,
  children,
}: {
  tabs: readonly TabLink[];
  /** Names the tab list for assistive tech: "Project settings". */
  label: string;
  children: ReactNode;
}) {
  return (
    <Page>
      <PageHeader title="Settings" tabs={<TabNav tabs={tabs} label={label} />} />
      {children}
    </Page>
  );
}
