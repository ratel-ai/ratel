import { notFound } from "next/navigation";
import { composition } from "@/lib/composition/ports";
import { type ProjectScope, requireProjectScope } from "@/lib/console/scope/project-scope";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { isDbConfigured } from "@/lib/platform/db/client";
import { type FeatureFlagDeps, featureEnabled } from "@/lib/platform/experimental-features";

export interface ScorersPageDeps {
  isDbConfigured: () => boolean;
  requireProjectScope: (projectId: string) => Promise<ProjectScope>;
  featureEnabled: typeof featureEnabled;
  /** The edition's flags port; undefined without one. */
  flagsPort: () => FeatureFlagDeps["port"];
}

const defaults: ScorersPageDeps = {
  isDbConfigured,
  requireProjectScope,
  featureEnabled,
  flagsPort: () => composition.featureFlags,
};

/**
 * What every Scorers page starts from. The flag decides first: off, the pages do not exist, also
 * where no database is configured. On without a database: null, and the page shows the setup
 * notice. Else the reader's project.
 */
export function resolveScorersPage(
  projectId: string,
  deps: ScorersPageDeps = defaults,
): Promise<{ projectId: string } | null> {
  return withFeatureSpan(
    "scorers",
    "resolve_page",
    async () => {
      if (!deps.isDbConfigured()) {
        if (!(await enabledWithoutDatabase(deps))) notFound();
        return null;
      }
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

/**
 * The configuration decides. An edition's port decides per organization, which only the database
 * knows, so with a port only a forced value can turn the flag on: fail closed.
 */
function enabledWithoutDatabase(deps: ScorersPageDeps): Promise<boolean> {
  const closed = { enabled: async () => false };
  return deps.featureEnabled("scorers", {}, { port: deps.flagsPort() ? closed : undefined });
}
