import type { ReactNode } from "react";
import { SettingsFrame } from "@/components/console/settings/SettingsFrame";
import { organizationSettingsTabs } from "@/lib/console/settings/tabs";
import { getConsoleScope } from "@/lib/console/shell-data";
import { isDbConfigured } from "@/lib/platform/db/client";

/**
 * Organization settings share one header and its URL tabs: General for
 * everyone, Danger zone for the admins who can use it. Without a database the
 * page says so on its own.
 */
export default async function OrganizationSettingsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  if (!isDbConfigured()) return children;
  const [{ orgSlug }, scope] = await Promise.all([params, getConsoleScope()]);
  return (
    <SettingsFrame
      label="Organization settings"
      tabs={organizationSettingsTabs(orgSlug, { danger: scope?.role === "admin" })}
    >
      {children}
    </SettingsFrame>
  );
}
