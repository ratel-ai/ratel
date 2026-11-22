import { typedStepsOn } from "@/lib/platform/typed-steps-flag";

/**
 * `cloud-typed-steps` (RC-1067): typed steps make turns, including traces with only model
 * calls. Off, ingest, the turn build and the readings give the same rows as before.
 *
 * Owned (ADR-0030): the switch is the core's `FF_TYPED_STEPS`
 * (`lib/platform/typed-steps-flag.ts`), off by default: the environment without the edition's
 * flags port, else the edition decides it for the project and organization, after any `FF_*`
 * value the operator set. The function keeps upstream's name and arguments, so every caller
 * stays upstream's; the last argument is the environment instead of the flag deps.
 */

type Env = Record<string, string | undefined>;

/** Whether typed steps are on for the project (and its organization, when known). Never throws: a failed decision is off. */
export async function typedStepsEnabled(
  projectId: string,
  organization?: unknown,
  env: Env = process.env,
): Promise<boolean> {
  const organizationId = organizationIdOf(organization);
  return typedStepsOn(organizationId ? { projectId, organizationId } : { projectId }, { env });
}

/** The organization's id when the caller passed one (upstream passes its organization record or id). */
function organizationIdOf(organization: unknown): string | undefined {
  if (typeof organization === "string") return organization || undefined;
  if (typeof organization !== "object" || organization === null || !("id" in organization)) {
    return undefined;
  }
  return typeof organization.id === "string" ? organization.id : undefined;
}
