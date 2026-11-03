import type { ReactNode } from "react";
import { SettingsFrame } from "@/components/console/settings/SettingsFrame";
import { composition } from "@/lib/composition";
import { organizationRoot } from "@/lib/console/navigation";
import { isDbConfigured } from "@/lib/platform/db/client";

/**
 * Organization settings share one header and its URL tabs. Only the tabs this build has are
 * listed. Without a database the page says so on its own.
 */
export default async function OrganizationSettingsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  if (!isDbConfigured()) return children;
  const [{ orgSlug }, ui] = await Promise.all([params, composition.ui?.()]);
  const root = `${organizationRoot(orgSlug)}/settings`;
  const tabs = [{ href: root, label: "General", exact: true }];
  if (ui?.OrganizationDangerSettings)
    tabs.push({ href: `${root}/danger`, label: "Danger zone", exact: true });
  return (
    <SettingsFrame label="Organization settings" tabs={tabs}>
      {children}
    </SettingsFrame>
  );
}
