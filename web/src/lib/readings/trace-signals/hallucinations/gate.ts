import type { FlagSubject } from "@/lib/contracts/feature-flags";
import { type FeatureFlagDeps, featureEnabled } from "@/lib/platform/experimental-features";
import type { Organization } from "@/lib/platform/organizations";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";

/**
 * Whether hallucination detection (`hallucinationDetection`) is on:
 * the page under Agent health, its markers in Traces, and the reading that
 * fills them. Decided for the PROJECT's organization, never a person's active
 * one, so a rollout targets organizations by `organization_id`.
 *
 * Owned (ADR-0004): the switch is the core's `hallucinationDetection`, off by
 * default. Without the edition's flags port it is one switch for the
 * deployment, read from the configuration (or `experimentalFeatures` in the
 * open-source edition); with it, the edition decides it for the organization
 * (`featureEnabled`), after any value the operator forced. The last argument
 * of each check is the flag read's deps.
 */
export const HALLUCINATION_DETECTION_FLAG = "hallucinationDetection" as const;

/** Who asks, beside the organization: the signed-in person, when there is one. */
export type FlagIdentity = Pick<FlagSubject, "actor">;

/** The page's and the Traces markers' check, for the organization that owns the project. */
export async function hallucinationDetectionEnabled(
  organization: Pick<Organization, "id">,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<boolean> {
  return featureEnabled(HALLUCINATION_DETECTION_FLAG, { organizationId: organization.id }, deps);
}

/** The rail's check: which of the person's organizations have the page on. A failed decision is off. */
export async function hallucinationOrganizationIds(
  organizations: readonly Pick<Organization, "id">[],
  identity: FlagIdentity = {},
  deps: Partial<FeatureFlagDeps> = {},
): Promise<string[]> {
  const decided = await Promise.all(
    organizations.map(async (organization) =>
      (await featureEnabled(
        HALLUCINATION_DETECTION_FLAG,
        { organizationId: organization.id, ...identity },
        deps,
      ).catch(() => false))
        ? [organization.id]
        : [],
    ),
  );
  return decided.flat();
}

export interface ReadingGateDeps {
  getOrganization: (projectId: string) => Promise<Pick<Organization, "id"> | null>;
  flags: Partial<FeatureFlagDeps>;
}

export const defaultReadingGateDeps: ReadingGateDeps = {
  getOrganization: getOrganizationByProjectId,
  flags: {},
};

/**
 * The reading's switch, decided for a background job (as the Sentiment
 * questions' switch, `outcomes/questions-gate.ts`): there is no signed-in
 * person, so the identity is the project and only the organization is sent.
 * With the switch off the reading loads nothing and writes nothing. A project
 * with no organization is off.
 */
export async function hallucinationReadingEnabled(
  projectId: string,
  deps: ReadingGateDeps = defaultReadingGateDeps,
): Promise<boolean> {
  const organization = await deps.getOrganization(projectId);
  if (!organization) return false;
  return featureEnabled(
    HALLUCINATION_DETECTION_FLAG,
    { organizationId: organization.id, projectId, actor: `project:${projectId}` },
    deps.flags,
  );
}
