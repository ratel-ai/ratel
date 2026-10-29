import type { ReactNode } from "react";
import { SettingsFrame } from "@/components/console/settings/SettingsFrame";
import { projectRoot } from "@/lib/console/navigation";
import { isDbConfigured } from "@/lib/platform/db/client";

/**
 * Project settings share one header and its URL tabs, so a tab switch keeps the header and loads
 * only the tab. Only the tabs this build has are listed. Without a database each tab says so on
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
  const root = `${projectRoot(projectId)}/settings`;
  return (
    <SettingsFrame label="Project settings" tabs={[{ href: root, label: "General", exact: true }]}>
      {children}
    </SettingsFrame>
  );
}
