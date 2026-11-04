import { claimSampleProjectSeeding, recordSampleProject } from "@/lib/console/onboarding/queries";
import { seedSiteCopilot } from "@/lib/console/seed/site-copilot-seed";
import { scheduleProjectDrain } from "@/lib/jobs/route-helpers";
import { getLogger } from "@/lib/platform/logger";
import type { Organization } from "@/lib/platform/organizations";
import { listProjectsForOrganization } from "@/lib/platform/projects/queries";
import { reportServerException, trackProductEvent } from "@/lib/platform/telemetry";

/**
 * Give an empty organization its sample project, once.
 *
 * Not behind a feature flag. A sample project is a one-time welcome, not a
 * surface anybody keeps looking at, so there is nothing to roll out gradually
 * and nothing to measure a percentage of. The two conditions below already do
 * the job a flag would: they make the blast radius "accounts with nothing in
 * them", which is the population this is for, and nobody else.
 *
 * Two conditions, and both matter:
 *
 *   1. The organization has no projects at all. This is what stops the first
 *      deploy from dropping an unrequested project into an established account
 *      that is busy using the product. Checked first here, because the console
 *      scope has already loaded the list: an organization with projects never
 *      reaches the table.
 *   2. The organization has never been seeded (no `sample_project_seeds` row).
 *      This is what stops a deleted sample project coming back: the mark lives
 *      on the organization, not on the project row. Owned (ADR-0030): upstream
 *      keeps it as a column of the organizations table, which identity owns
 *      here, so it is a public table keyed on the organization id instead.
 *
 * Why inline rather than a background job: there is no job runner on this path,
 * and the whole point of the sample project is that it is *already there* when
 * the first page renders. A queued seed would show the empty console this
 * exists to prevent, then quietly fill in behind the reader. The readings that
 * follow (the turn ledger, Agent health) do run as jobs: a drain is scheduled
 * after the response.
 *
 * Failure is contained on purpose. Seeding is a nicety layered on top of
 * sign-in, so a broken seed must never stop somebody getting into their
 * account: the error is logged, reported, and swallowed. The mark is
 * claimed *before* the seed runs, so a seed that fails stays failed rather than
 * re-running on every subsequent request.
 */

const logger = getLogger("onboarding/provision-sample");

export interface EnsureSampleProjectContext {
  organization: Organization;
  /** The session user's stable id, so the analytics event attributes to a person. */
  externalId: string;
}

export interface EnsureSampleProjectDeps {
  listProjects: (organizationId: string) => Promise<readonly { id: string }[]>;
  claim: (organizationId: string, at: Date) => Promise<boolean>;
  seed: (organizationId: string) => Promise<{
    projectId: string;
    projectSlug: string;
    skills: number;
    traces: number;
    searchEvents: number;
  }>;
  record: (organizationId: string, projectId: string) => Promise<void>;
  scheduleDrain: (projectId: string) => void;
  track: typeof trackProductEvent;
  reportException: typeof reportServerException;
  now: () => number;
}

const defaultDeps: EnsureSampleProjectDeps = {
  listProjects: listProjectsForOrganization,
  claim: claimSampleProjectSeeding,
  seed: (organizationId) => seedSiteCopilot({ organizationId }),
  record: recordSampleProject,
  scheduleDrain: scheduleProjectDrain,
  track: trackProductEvent,
  reportException: reportServerException,
  now: () => Date.now(),
};

/** Returns the seeded project id, or null when nothing was seeded. */
export async function ensureSampleProject(
  { organization, externalId }: EnsureSampleProjectContext,
  deps: EnsureSampleProjectDeps = defaultDeps,
): Promise<string | null> {
  let claimed = false;
  try {
    const existing = await deps.listProjects(organization.id);
    if (existing.length > 0) return null;

    claimed = await deps.claim(organization.id, new Date(deps.now()));
    if (!claimed) return null;

    const startedAt = deps.now();
    const result = await deps.seed(organization.id);
    const durationMs = deps.now() - startedAt;
    await deps.record(organization.id, result.projectId);
    deps.scheduleDrain(result.projectId);

    logger.info(
      {
        orgId: organization.id,
        projectId: result.projectId,
        skills: result.skills,
        traces: result.traces,
        searchEvents: result.searchEvents,
        durationMs,
      },
      "sample project seeded",
    );
    await deps.track(
      "demo_project_seeded",
      { externalId, orgId: organization.id, projectId: result.projectId },
      {
        project_slug: result.projectSlug,
        skills: result.skills,
        runs: result.traces,
        traces: result.traces,
        duration_ms: durationMs,
      },
    );
    return result.projectId;
  } catch (error) {
    logger.error({ err: error, orgId: organization.id, claimed }, "sample project seeding failed");
    deps.reportException(error, `organization:${organization.id}`, {
      operation: "demo_project_seed",
      organization_id: organization.id,
    });
    await deps.track(
      "demo_project_seed_failed",
      { externalId, orgId: organization.id },
      { reason: error instanceof Error ? error.message : "unknown" },
    );
    return null;
  }
}
