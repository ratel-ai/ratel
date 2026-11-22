import type { FlagSubject } from "@/lib/contracts/feature-flags";
import { type FeatureFlagDeps, featureEnabled } from "@/lib/platform/experimental-features";

/**
 * `FF_SANDBOXES`: agent sandboxes (ratel-cloud RC-1090 and its milestones, upstream's
 * `cloud-sandboxes`). On, the `label_workflows` and `assign_topics` jobs stamp their sandbox
 * (`ratel.sandbox.*`) on their spans and the workflow label cache key includes the config hash;
 * OTLP ingest keeps playground runs out of cost and Agent health; the Sandboxes pages, the run
 * API and `POST /api/v1/runner/connect` answer. Off, those routes answer 404 and the jobs and
 * ingest give the same rows as before.
 *
 * A core switch (ADR-0030), off by default. Without the edition's flags port it is one switch for
 * the deployment, read from the environment (or `RATEL_EXPERIMENTAL_FEATURES` in the open-source
 * edition); with it, the edition decides it for the project (`featureEnabled`). It lives in the
 * platform layer because ingest, the readings and the console read it. Owned (ADR-0030): it keeps
 * upstream's names (`lib/sandboxes/flag.ts`), so every caller stays upstream's; the last argument
 * is the flag deps instead of the Cloud ingest flag deps.
 */
export const SANDBOXES_FLAG = "FF_SANDBOXES" as const;

/** Whether sandboxes are on for this subject (a project, at least). Never throws: a failed decision is off. */
export function sandboxesOn(
  subject: FlagSubject,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<boolean> {
  return featureEnabled(SANDBOXES_FLAG, subject, deps);
}

/** `FF_SANDBOXES` when the caller already holds the organization (ingest). Never throws: a failed read is off. */
export function sandboxesEnabledForOrganization(
  projectId: string,
  organization: unknown,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<boolean> {
  const organizationId = organizationIdOf(organization);
  return sandboxesOn(organizationId ? { projectId, organizationId } : { projectId }, deps);
}

/** Whether the job stamps its sandbox, and the pages and routes answer, for this project. Never throws. */
export function sandboxesEnabledForProject(
  projectId: string,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<boolean> {
  return sandboxesOn({ projectId }, deps);
}

/** The organization's id when the caller passed one (upstream passes its organization record or id). */
function organizationIdOf(organization: unknown): string | undefined {
  if (typeof organization === "string") return organization || undefined;
  if (typeof organization !== "object" || organization === null || !("id" in organization)) {
    return undefined;
  }
  return typeof organization.id === "string" && organization.id ? organization.id : undefined;
}
