import type { ReactNode } from "react";
import { SettingsFrame } from "@/components/console/settings/SettingsFrame";
import { projectTabs } from "@/lib/console/settings/project-tabs";
import { dbConfigured } from "@/lib/platform/db/request";

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
  if (!(await dbConfigured())) return children;
  const { projectId } = await params;
  return (
    <SettingsFrame label="Project settings" tabs={await projectTabs(projectId)}>
      {children}
    </SettingsFrame>
  );
}
