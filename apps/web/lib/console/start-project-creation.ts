import { newProjectHref, organizationRoot } from "@/lib/console/navigation";
import type { AccountPlanView, OrgLimitView } from "@/lib/platform/entitlements";
import {
  PROJECT_LIMIT_PARAM,
  PROJECT_LIMIT_VALUE,
  type ProjectCapacity,
  projectCapacity,
} from "@/lib/platform/projects/capacity";

type Organization = OrgLimitView & AccountPlanView & { id: string; slug: string };

export type StartProjectCreationDeps = {
  /** The session organization; null without a session. */
  organization: () => Promise<Organization | null>;
  listProjects: (organizationId: string) => Promise<ReadonlyArray<{ isDemo?: boolean | null }>>;
  /** Reports a click that met the cap (`quota_limit_hit`). */
  onRefused: (organization: Organization, capacity: ProjectCapacity) => Promise<void>;
};

export type StartProjectCreation = { redirect: string } | { notFound: true };

/**
 * Where "New project" goes (owned port of upstream's action): onboarding for this organization,
 * which creates the project and its API key and shows the key once. At the plan's cap it goes
 * back to the projects page with the reason instead, rather than letting onboarding's own guard
 * bounce the request: only this side can say why. One organization here, so there is nothing to
 * switch to: a slug that is not the session's is not found.
 */
export async function startProjectCreation(
  organizationSlug: string,
  deps: StartProjectCreationDeps,
): Promise<StartProjectCreation> {
  const organization = await deps.organization();
  if (!organization) return { redirect: "/" };
  if (organization.slug !== organizationSlug) return { notFound: true };
  const capacity = projectCapacity(organization, await deps.listProjects(organization.id));
  if (capacity.atCap) {
    await deps.onRefused(organization, capacity);
    return {
      redirect: `${organizationRoot(organization.slug)}?${PROJECT_LIMIT_PARAM}=${PROJECT_LIMIT_VALUE}`,
    };
  }
  return { redirect: newProjectHref(organization.slug) };
}
