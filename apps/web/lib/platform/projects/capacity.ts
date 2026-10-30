import type { PlanId } from "@/lib/platform/entitlements";
import {
  type AccountPlanView,
  billableProjectCount,
  checkQuota,
  getLimits,
  type OrgLimitView,
  resolvePlanId,
} from "@/lib/platform/entitlements";

/**
 * Whether an organization can create another project, and what to say when it
 * cannot.
 *
 * One function because three places need the same answer and used to derive it
 * separately: the Projects page renders the button, the action behind that
 * button runs, and `/onboarding` guards itself on arrival. When only the last
 * of those knew about the cap, clicking "New project" at the limit produced a
 * redirect to `/onboarding` and an immediate redirect back, which looks exactly
 * like a page that refreshed and did nothing.
 *
 * The counts are part of the return value, not just the verdict, because the
 * confusing case is specifically a Free account holding TWO projects while the
 * limit reads one. The seeded demo project does not count (see
 * `billableProjectCount`), so any message that does not say so describes a
 * screen the reader is not looking at.
 */

/** Query parameter the refusing surfaces set so the Projects page can explain. */
export const PROJECT_LIMIT_PARAM = "limit";
export const PROJECT_LIMIT_VALUE = "projects";

export interface ProjectCapacity {
  /** Projects that count against the cap: everything except the demo. */
  used: number;
  /** `Infinity` on Enterprise. */
  limit: number;
  plan: PlanId;
  /** True when the demo project is present and therefore excluded from `used`. */
  hasDemoProject: boolean;
  atCap: boolean;
}

export function projectCapacity(
  organization: OrgLimitView & AccountPlanView,
  projects: ReadonlyArray<{ isDemo?: boolean | null }>,
): ProjectCapacity {
  const used = billableProjectCount(projects);
  return {
    used,
    limit: getLimits(organization).maxProjects,
    plan: resolvePlanId(organization),
    hasDemoProject: projects.some((project) => Boolean(project.isDemo)),
    atCap: !checkQuota(organization, "maxProjects", used).ok,
  };
}

/** "1 of 1", or "2 of ∞" on Enterprise. Shown next to the Projects heading. */
export function formatProjectUsage(capacity: ProjectCapacity): string {
  const limit = Number.isFinite(capacity.limit) ? capacity.limit : "∞";
  return `${capacity.used} of ${limit}`;
}

/**
 * Why creating another project is refused, in one sentence a person can act on.
 *
 * Names the demo project explicitly when one is present. Without that clause
 * the message contradicts the screen: the reader can see two projects and is
 * being told the limit is one.
 */
export function projectLimitMessage(capacity: ProjectCapacity): string {
  const plural = capacity.limit === 1 ? "project" : "projects";
  const planName = capacity.plan.charAt(0).toUpperCase() + capacity.plan.slice(1);
  const demoClause = capacity.hasDemoProject ? " The demo project does not count toward it." : "";
  return `${planName} includes ${capacity.limit} ${plural}, and you are using ${capacity.used === 1 ? "it" : "all of them"}.${demoClause}`;
}
