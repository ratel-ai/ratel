import { type ProjectScope, requireProjectScope } from "@/lib/console/scope/project-scope";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { isDbConfigured } from "@/lib/platform/db/client";

export interface FeaturePageDeps {
  isDbConfigured: () => boolean;
  requireProjectScope: (projectId: string) => Promise<ProjectScope>;
}

/** Who reads the page. */
export interface FeaturePage {
  projectId: string;
  organizationId: string;
  actor: string;
}

const defaults: FeaturePageDeps = {
  isDbConfigured,
  requireProjectScope,
};

/**
 * What every page of a monitoring feature starts from: the reader's project, or null where no
 * database is configured, and the page shows the setup notice.
 */
export function resolveFeaturePage(
  feature: "scorers" | "alerts" | "explore",
  projectId: string,
  deps: FeaturePageDeps = defaults,
): Promise<FeaturePage | null> {
  return withFeatureSpan(
    feature,
    "resolve_page",
    async () => {
      if (!deps.isDbConfigured()) return null;
      const { project, organization, user } = await deps.requireProjectScope(projectId);
      return {
        projectId: project.id,
        organizationId: organization.id,
        actor: user.externalId,
      };
    },
    { attributes: { "project.id": projectId } },
  );
}
