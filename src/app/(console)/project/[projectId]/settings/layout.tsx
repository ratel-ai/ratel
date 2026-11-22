import type { ReactNode } from "react";
import { SettingsFrame } from "@/components/console/settings/SettingsFrame";
import { projectSettingsTabs } from "@/lib/console/settings/tabs";
import { isDbConfigured } from "@/lib/platform/db/client";

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
  return (
    <SettingsFrame label="Project settings" tabs={projectSettingsTabs(projectId)}>
      {children}
    </SettingsFrame>
  );
}
