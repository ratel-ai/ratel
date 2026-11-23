import { type FeatureFlagDeps, featureEnabled } from "@/lib/platform/experimental-features";
import type { Organization } from "@/lib/platform/organizations";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";

/**
 * The switch of the model questions (`model-read.ts`): they are asked only
 * for a project whose organization has Sentiment analysis on, the same flag
 * the page sits behind (`cloud-sentiment-analysis`, `gate.ts`). A key alone
 * never turns them on: with the switch off the reading loads no text, makes
 * no call and writes rule-only rows.
 *
 * Decided for a background job, not a request: there is no signed-in person,
 * so the identity is the project and only the organization is sent. A rollout
 * that targets the organization turns the questions on for that
 * organization's projects; one that targets a person does not. A value the
 * configuration forces wins as everywhere. Without an edition's flags port,
 * or when the decision fails, the flag reads its default: off.
 *
 * Owned (ADR-0004): the switch is the core's `sentimentAnalysis`, read
 * through `featureEnabled`. Here it also decides whether a signal run reads
 * outcomes at all (`signals/compute-job.ts`): with the switch off the three
 * outcome tables stay empty.
 */

/** The page's flag (`SENTIMENT_ANALYSIS_FLAG` in `gate.ts`): one switch for the page and its questions. */
export const SENTIMENT_QUESTIONS_FLAG = "sentimentAnalysis" as const;

export interface QuestionsGateDeps {
  getOrganization: (projectId: string) => Promise<Pick<Organization, "id"> | null>;
  flags: Partial<FeatureFlagDeps>;
}

export const defaultQuestionsGateDeps: QuestionsGateDeps = {
  getOrganization: getOrganizationByProjectId,
  flags: {},
};

/** Whether the questions are switched on for the project's organization. A project with no organization is off. */
export async function sentimentQuestionsEnabled(
  projectId: string,
  deps: QuestionsGateDeps = defaultQuestionsGateDeps,
): Promise<boolean> {
  const organization = await deps.getOrganization(projectId);
  if (!organization) return false;
  return featureEnabled(
    SENTIMENT_QUESTIONS_FLAG,
    { organizationId: organization.id, projectId, actor: `project:${projectId}` },
    deps.flags,
  );
}
