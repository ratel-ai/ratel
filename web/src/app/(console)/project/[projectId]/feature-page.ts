import { notFound } from "next/navigation";
import { composition } from "@/lib/composition/ports";
import { type ProjectScope, requireProjectScope } from "@/lib/console/scope/project-scope";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { dbConfigured } from "@/lib/platform/db/request";
import { type FeatureFlagDeps, featureEnabled } from "@/lib/platform/experimental-features";

export interface FeaturePageDeps {
  dbConfigured: () => Promise<boolean>;
  requireProjectScope: (projectId: string) => Promise<ProjectScope>;
  featureEnabled: typeof featureEnabled;
  /** The edition's flags port; undefined without one. */
  flagsPort: () => FeatureFlagDeps["port"];
}

/** Who reads the page, as the flags ask for it. */
export interface FeaturePage {
  projectId: string;
  organizationId: string;
  actor: string;
}

const defaults: FeaturePageDeps = {
  dbConfigured,
  requireProjectScope,
  featureEnabled,
  flagsPort: () => composition.featureFlags,
};

/**
 * What every page of a `customMonitoring` feature starts from. The flag decides first: off, the pages do not
 * exist, also where no database is configured. On without a database: null, and the page shows the
 * setup notice. Else the reader's project.
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
      if (!(await deps.dbConfigured())) {
        if (!(await enabledWithoutDatabase(deps))) notFound();
        return null;
      }
      const { project, organization, user } = await deps.requireProjectScope(projectId);
      const page = {
        projectId: project.id,
        organizationId: organization.id,
        actor: user.externalId,
      };
      if (!(await deps.featureEnabled("customMonitoring", page))) notFound();
      return page;
    },
    { attributes: { "project.id": projectId } },
  );
}

/**
 * The configuration decides. An edition's port decides per organization, which only the database
 * knows, so with a port only a forced value can turn the flag on: fail closed.
 */
function enabledWithoutDatabase(deps: FeaturePageDeps): Promise<boolean> {
  const closed = { enabled: async () => false };
  return deps.featureEnabled(
    "customMonitoring",
    {},
    { port: deps.flagsPort() ? closed : undefined },
  );
}
