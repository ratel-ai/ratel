import type { Organization } from "@/lib/contracts/session";
import {
  defaultOrganizationFlagDeps,
  type OrganizationFlagDeps,
  organizationFlagEnabled,
} from "@/lib/platform/organization-flags";
import type { GateDb } from "@/lib/views/eval-gate/gate";

/**
 * Whether Evals (RC-279) is on for a project: `FF_EVALS`, decided for the person asking in the
 * PROJECT's organization. An API key (`project:<id>`) or a system run is decided with the
 * project only.
 *
 * Owned (ADR-0030): upstream rides the eval gate's Cloud flag (`cloud-eval-gate`) through its
 * flag vendor; here it is the core switch `FF_EVALS`, off by default (the environment, or the
 * edition's `featureFlags` port). Upstream's names and parameters stay, so every caller stays
 * upstream's: `db` is unused, and `deps` is upstream's flag seam (`platform/organization-flags`).
 */
export const EVALS_FLAG = "FF_EVALS" as const;

export const EVALS_OFF_ERROR = "Evals are off for this organization.";

export async function evalsEnabledForActor(
  projectId: string,
  actor: string,
  _db?: GateDb,
  deps: OrganizationFlagDeps = defaultOrganizationFlagDeps,
): Promise<boolean> {
  return organizationFlagEnabled(EVALS_FLAG, { projectId, actor }, deps);
}

/** The rail's check (RC-291): which of the person's organizations have Evals on. A failed decision is off. */
export async function evalsOrganizationIds(
  organizations: readonly Pick<Organization, "id">[],
  identity: { distinctId: string },
  deps: OrganizationFlagDeps = defaultOrganizationFlagDeps,
): Promise<string[]> {
  const decided = await Promise.all(
    organizations.map(async (organization) =>
      (await organizationFlagEnabled(
        EVALS_FLAG,
        { organizationId: organization.id, actor: identity.distinctId },
        deps,
      ).catch(() => false))
        ? [organization.id]
        : [],
    ),
  );
  return decided.flat();
}
