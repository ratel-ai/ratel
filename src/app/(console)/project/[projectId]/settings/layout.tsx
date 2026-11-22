import type { ReactNode } from "react";
import { SettingsFrame } from "@/components/console/settings/SettingsFrame";
import { pivotsVisible } from "@/lib/console/pivots/reader";
import { findProjectScope } from "@/lib/console/scope/project-scope";
import { projectSettingsTabs } from "@/lib/console/settings/tabs";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { codeHandoffEnabledFor } from "@/lib/views/code-handoff/gate";

/**
 * Project settings share one header and its URL tabs, so a tab switch keeps
 * the header and loads only the tab. Without a database each tab says so on
 * its own page.
 *
 * Owned (ADR-0030): the Repository tab reads `FF_CODE_HANDOFF` through the console's project
 * scope (one argument: the session's membership).
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
  // Pivots (RC-881) has a tab only with `cloud-pivots` on for the project.
  const pivots = await pivotsVisible(projectId);
  const repository = await repositoryTabShown(projectId);
  return (
    <SettingsFrame
      label="Project settings"
      tabs={projectSettingsTabs(projectId, { pivots, repository })}
    >
      {children}
    </SettingsFrame>
  );
}

/** The Repository tab is there only with `FF_CODE_HANDOFF` on in the project's organization. */
async function repositoryTabShown(projectId: string): Promise<boolean> {
  const session = await getSessionContext();
  if (!session) return false;
  const scope = await findProjectScope(projectId);
  return scope ? codeHandoffEnabledFor(scope.organization, {}, session.user.externalId) : false;
}
