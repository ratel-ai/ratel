import type { FlagSubject } from "@/lib/contracts/feature-flags";
import { type FeatureFlagDeps, featureEnabled } from "@/lib/platform/experimental-features";
import type { Organization } from "@/lib/platform/organizations";

/**
 * Whether Sentiment analysis (`cloud-sentiment-analysis`, RC-357) is on: the
 * page under Agent health and the routes behind it. Decided for the signed-in
 * person acting in the PROJECT's organization, never their active one, so a
 * rollout targets organizations by `organization_id`.
 *
 * Owned (ADR-0004): the switch is the core's `sentimentAnalysis`, off by
 * default. Without the edition's flags port it is one switch for the
 * deployment, read from the configuration (or `experimentalFeatures` in the
 * open-source edition); with it, the edition decides it for the organization
 * (`featureEnabled`), after any value the operator forced. Upstream's names
 * and arguments are kept so call sites stay identical; the last argument is
 * the flag read's deps.
 */
export const SENTIMENT_ANALYSIS_FLAG = "sentimentAnalysis" as const;

/** Who asks, beside the organization: the signed-in person, when there is one. */
export type FlagIdentity = Pick<FlagSubject, "actor">;

/** The page's and its routes' check, for the organization that owns the project. */
export async function sentimentAnalysisEnabled(
  organization: Pick<Organization, "id">,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<boolean> {
  return featureEnabled(SENTIMENT_ANALYSIS_FLAG, { organizationId: organization.id }, deps);
}

/** The rail's check: which of the person's organizations have the page on. A failed decision is off. */
export async function sentimentOrganizationIds(
  organizations: readonly Pick<Organization, "id">[],
  identity: FlagIdentity = {},
  deps: Partial<FeatureFlagDeps> = {},
): Promise<string[]> {
  const decided = await Promise.all(
    organizations.map(async (organization) =>
      (await featureEnabled(
        SENTIMENT_ANALYSIS_FLAG,
        { organizationId: organization.id, ...identity },
        deps,
      ).catch(() => false))
        ? [organization.id]
        : [],
    ),
  );
  return decided.flat();
}
