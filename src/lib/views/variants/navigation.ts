import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { getLogger } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";
import {
  type VariantExperimentsFlagOrganization,
  variantExperimentsEnabled,
} from "@/lib/platform/variants-flag";
import { projectsWithVariantTraffic, type VariantsDb } from "@/lib/views/variants/compare-store";

/**
 * The rail's check (RC-871): which of the person's projects show Variants. The
 * item needs `FF_VARIANT_EXPERIMENTS` on for the project and a tagged trace
 * in the last `VARIANT_NAV_DAYS` days; a failed decision or read hides it.
 *
 * Owned (ADR-0030): the switch is the core's `FF_VARIANT_EXPERIMENTS`
 * (`lib/platform/variants-flag.ts`) for the project and its organization's id,
 * not upstream's flag organization (slug and plan).
 */

export interface VariantsNavDeps {
  enabled: (
    projectId: string,
    organization: NonNullable<VariantExperimentsFlagOrganization>,
  ) => Promise<boolean>;
  projectsWithVariantTraffic: (projectIds: readonly string[], since: Date) => Promise<string[]>;
  now: () => Date;
}

export const VARIANT_NAV_DAYS = 30;
const DAY_MS = 86_400_000;
const logger = getLogger("variants/navigation");
/** The rail renders on every page: its read gives up fast. */
const NAV_READ_TIMEOUT_MS = 1_000;

export const defaultVariantsNavDeps: VariantsNavDeps = {
  enabled: (projectId, organization) => variantExperimentsEnabled(projectId, organization),
  projectsWithVariantTraffic: (projectIds, since) =>
    withStatementTimeout(
      (db) => projectsWithVariantTraffic(projectIds, since, db as unknown as VariantsDb),
      {
        operation: "nav_variants",
        timeoutMs: NAV_READ_TIMEOUT_MS,
      },
    ),
  now: () => new Date(),
};

export async function variantsProjectIds(
  organizations: readonly { id: string }[],
  projects: readonly { id: string; organizationId: string }[],
  deps: VariantsNavDeps = defaultVariantsNavDeps,
): Promise<string[]> {
  const byId = new Map(organizations.map((organization) => [organization.id, organization]));
  const decided = await Promise.all(
    projects.map(async (project) => {
      const organization = byId.get(project.organizationId);
      if (!organization) return [];
      return (await deps.enabled(project.id, { id: organization.id }).catch(() => false))
        ? [project.id]
        : [];
    }),
  );
  const candidates = decided.flat();
  if (candidates.length === 0) return [];
  try {
    return await deps.projectsWithVariantTraffic(
      candidates,
      new Date(deps.now().getTime() - VARIANT_NAV_DAYS * DAY_MS),
    );
  } catch (err) {
    logger.error({ err, projects: candidates.length }, "variants navigation read failed");
    reportServerException(err, "system:navigation", { component: "variants_navigation" });
    return [];
  }
}
