import { notFound } from "next/navigation";
import { type ProjectScope, requireProjectScope } from "@/lib/console/scope/project-scope";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { featureEnabled } from "@/lib/platform/experimental-features";

export interface ScorersPageDeps {
  requireProjectScope: (projectId: string) => Promise<ProjectScope>;
  featureEnabled: typeof featureEnabled;
}

const defaults: ScorersPageDeps = { requireProjectScope, featureEnabled };

/** What every Scorers page starts from: the reader's project, and the flag. Off, the pages do not exist. */
export function resolveScorersPage(
  projectId: string,
  deps: ScorersPageDeps = defaults,
): Promise<{ projectId: string }> {
  return withFeatureSpan(
    "scorers",
    "resolve_page",
    async () => {
      const { project, organization, user } = await deps.requireProjectScope(projectId);
      const on = await deps.featureEnabled("scorers", {
        projectId: project.id,
        organizationId: organization.id,
        actor: user.externalId,
      });
      if (!on) notFound();
      return { projectId: project.id };
    },
    { attributes: { "project.id": projectId } },
  );
}
