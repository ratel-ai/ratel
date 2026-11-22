import { getLogger } from "@/lib/platform/logger";
import { sandboxesEnabledForOrganization } from "@/lib/platform/sandboxes-flag";

/**
 * The rail's check (RC-1102): which of the person's projects show Sandboxes. `FF_SANDBOXES` is
 * decided per project and its organization, as the run API decides it, so the item shows exactly
 * where the pages answer. A failed decision hides it.
 *
 * Owned (ADR-0030): the switch is the core's `FF_SANDBOXES` (`lib/platform/sandboxes-flag.ts`),
 * read with `featureEnabled`, not upstream's organization flag service; the name and the
 * arguments stay upstream's.
 */

/** The switch for a project, given its organization. Never throws. */
export type SandboxesFlag = (projectId: string, organization: { id: string }) => Promise<boolean>;

const logger = getLogger("sandboxes/navigation");

export async function sandboxesProjectIds(
  organizations: readonly { id: string }[],
  projects: readonly { id: string; organizationId: string }[],
  isEnabled: SandboxesFlag = sandboxesEnabledForOrganization,
): Promise<string[]> {
  const known = new Set(organizations.map((o) => o.id));
  const decided = await Promise.all(
    projects.map(async (project) => {
      if (!known.has(project.organizationId)) return [];
      try {
        const enabled = await isEnabled(project.id, { id: project.organizationId });
        return enabled ? [project.id] : [];
      } catch (err) {
        logger.error({ err, project_id: project.id }, "sandboxes navigation flag failed");
        return [];
      }
    }),
  );
  return decided.flat();
}
