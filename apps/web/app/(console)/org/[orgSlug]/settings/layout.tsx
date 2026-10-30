import type { ReactNode } from "react";
import { SettingsFrame } from "@/components/console/settings/SettingsFrame";
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
  const { orgSlug } = await params;
  const root = `${organizationRoot(orgSlug)}/settings`;
  return (
    <SettingsFrame
      label="Organization settings"
      tabs={[{ href: root, label: "General", exact: true }]}
    >
      {children}
    </SettingsFrame>
  );
}
