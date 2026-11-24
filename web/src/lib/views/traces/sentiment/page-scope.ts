import { getProjectScope, type ProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { sentimentAnalysisEnabled } from "@/lib/readings/trace-signals/outcomes/gate";

/**
 * The project a Sentiment analysis or Root cause analysis page renders for, or null when the
 * page is not found: no database, or `sentimentAnalysis` off for the project's organization.
 * The project is scoped first (`getProjectScope` turns a non-member away), so the switch is
 * read for an organization the reader belongs to. Not an upstream file: both pages called the
 * same three checks inline, which no test could reach.
 */

/** What the decision reads; the defaults are the deployment's. */
export interface SentimentPageScopeDeps {
  dbConfigured: () => boolean;
  getProjectScope: (projectId: string) => Promise<ProjectScope>;
  enabled: (organization: ProjectScope["organization"]) => Promise<boolean>;
}

const defaults: SentimentPageScopeDeps = {
  dbConfigured: isDbConfigured,
  getProjectScope,
  enabled: (organization) => sentimentAnalysisEnabled(organization),
};

export async function sentimentPageScope(
  projectId: string,
  deps: SentimentPageScopeDeps = defaults,
): Promise<ProjectScope | null> {
  if (!deps.dbConfigured()) return null;
  const scope = await deps.getProjectScope(projectId);
  return (await deps.enabled(scope.organization)) ? scope : null;
}
