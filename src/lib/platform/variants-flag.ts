import type { FlagSubject } from "@/lib/contracts/feature-flags";
import { type FeatureFlagDeps, featureEnabled } from "@/lib/platform/experimental-features";

/**
 * `FF_VARIANT_EXPERIMENTS`: variant experiments (ratel-cloud RC-861 and its milestones,
 * upstream's `cloud-variant-experiments`). On, OTLP ingest keeps each span's `ratel.variant.*`
 * tags (and a project's mapped attribute, RC-869) on its span row, the summary sweep rolls them up
 * per trace, Settings > General shows Variant attributes, and the Variants pages and the MCP tools
 * `list_variant_experiments` and `get_variant_experiment` answer. Off, ingest writes no variant
 * column and the pages and tools do not exist.
 *
 * A core switch (ADR-0030), off by default. Without the edition's flags port it is one switch for
 * the deployment, read from the environment (or `RATEL_EXPERIMENTAL_FEATURES` in the open-source
 * edition); with it, the edition decides it for the project (`featureEnabled`). It lives in the
 * platform layer because ingest, the console and the MCP tools read it. Owned (ADR-0030): it keeps
 * upstream's names (`lib/variants/flag.ts`), so every caller stays upstream's; the organization
 * only narrows the subject, and the last argument is the flag deps instead of the Cloud ingest
 * flag deps.
 */
export const VARIANT_EXPERIMENTS_FLAG = "FF_VARIANT_EXPERIMENTS" as const;

/** The organization a caller holds when it asks for a project: any record with an `id`, or none. */
export type VariantExperimentsFlagOrganization = {
  readonly id: string;
  readonly [key: string]: unknown;
} | null;

/** The switch for a project, given its organization when the caller holds it. Never throws. */
export type VariantExperimentsFlag = (
  projectId: string,
  organization: VariantExperimentsFlagOrganization,
) => Promise<boolean>;

/** Whether variant experiments are on for this subject (a project, at least). Never throws: a failed decision is off. */
export function variantExperimentsOn(
  subject: FlagSubject,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<boolean> {
  return featureEnabled(VARIANT_EXPERIMENTS_FLAG, subject, deps);
}

/** Whether the switch is on for the project. Never throws: a failed decision is off. */
export function variantExperimentsEnabled(
  projectId: string,
  organization: VariantExperimentsFlagOrganization | string = null,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<boolean> {
  const organizationId = organizationIdOf(organization);
  return variantExperimentsOn(organizationId ? { projectId, organizationId } : { projectId }, deps);
}

/** The organization's id when the caller passed one. */
function organizationIdOf(organization: unknown): string | undefined {
  if (typeof organization === "string") return organization || undefined;
  if (typeof organization !== "object" || organization === null || !("id" in organization)) {
    return undefined;
  }
  return typeof organization.id === "string" && organization.id ? organization.id : undefined;
}
