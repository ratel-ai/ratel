import type { Organization } from "@/lib/contracts/session";
import { type FeatureFlagDeps, featureEnabled } from "@/lib/platform/experimental-features";

/**
 * Whether code handoff (`FF_CODE_HANDOFF`, upstream's `cloud-code-handoff`, RC-862: the GitHub
 * repo link, the handoff issue and the deploy watch) is on for a project. Decided in the
 * PROJECT's organization, as upstream decides it.
 *
 * Owned (ADR-0030): a core switch, off by default. Without the edition's flags port it is one
 * switch for the deployment, read from the environment (or `RATEL_EXPERIMENTAL_FEATURES` in the
 * open-source edition); with it, the edition decides it for the organization and the person, or
 * for a caller with no session (a webhook, a job, MCP) by the project (`featureEnabled`).
 */
export const CODE_HANDOFF_FLAG = "FF_CODE_HANDOFF" as const;

/**
 * The signed-in person, acting in this organization (the project's). `actor` is the person's
 * identity-provider id. Never throws: a failed decision is off.
 */
export function codeHandoffEnabledFor(
  organization: Pick<Organization, "id">,
  deps: Partial<FeatureFlagDeps> = {},
  actor?: string,
): Promise<boolean> {
  return featureEnabled(
    CODE_HANDOFF_FLAG,
    { organizationId: organization.id, ...(actor ? { actor } : {}) },
    deps,
  );
}

/**
 * The switch for whoever asked, with no session: a person (an identity-provider id), an API key
 * (`project:<id>`) or a system actor (`system:<name>`), decided with the project.
 */
export function codeHandoffEnabledForActor(
  projectId: string,
  actor: string,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<boolean> {
  return featureEnabled(CODE_HANDOFF_FLAG, { projectId, actor }, deps);
}
