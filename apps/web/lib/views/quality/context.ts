import { redirect } from "next/navigation";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import {
  billingSelfServe,
  checkMeteredFeature,
  type FeatureAccess,
} from "@/lib/platform/entitlements";
import type { Organization } from "@/lib/platform/identity/schema";
import type { Project } from "@/lib/platform/projects/schema";
import type { ResolvedRange } from "@/lib/synthesis/dashboard";
import { countRunsSince } from "@/lib/synthesis/match-quality/queries";
import { startOfBillingPeriod } from "@/lib/synthesis/match-quality/window";
import {
  type QualitySources,
  type QualityTab,
  type QualityWindowParams,
  qualityTabHref,
  resolveQualityWindow,
  visibleTabs,
  windowSearch,
} from "./model";

/**
 * Everything a Quality tab decides before it reads any data: who is asking,
 * which sources are on, and whether the plan includes match quality. One
 * place, so the three tabs gate the same way the rail does. Owned (ADR-0030): the
 * project comes from the console scope, a 404 otherwise.
 */

export interface QualityContext {
  project: Project;
  organization: Organization;
  sources: QualitySources;
  tabs: QualityTab[];
  window: ResolvedRange;
  /** The query string that carries the window between tabs. */
  search: string;
  /** Match quality's plan check. */
  access: FeatureAccess | null;
  /** Where the plan is changed; null when Ratel manages the workspace's plan. */
  billingHref: string | null;
  now: Date;
}

/** Whether the plan lets this project see misses and suggestions at all. */
export function entitled(context: Pick<QualityContext, "access">): boolean {
  return context.access !== null && (context.access.ok || context.access.reason === "exhausted");
}

export async function loadQualityContext(
  projectId: string,
  tab: QualityTab,
  params: QualityWindowParams,
): Promise<QualityContext> {
  const { project, organization } = await requireProjectScope(projectId);

  // Every source is on for everyone; the plan decides what match quality may spend.
  const sources: QualitySources = { matchQuality: true, calibration: true };

  const now = new Date();
  const window = resolveQualityWindow(params, now);
  const search = windowSearch(window);
  const tabs = visibleTabs(sources);
  if (!tabs.includes(tab)) redirect(qualityTabHref(project.id, tabs[0]!, search));

  const used = await countRunsSince(project.id, startOfBillingPeriod(now));
  const access: FeatureAccess | null = checkMeteredFeature(
    organization,
    "matchQualityRunsPerMonth",
    used,
    "Match quality",
  );

  return {
    project,
    organization,
    sources,
    tabs,
    window,
    search,
    access,
    billingHref: billingSelfServe(organization)
      ? `/org/${encodeURIComponent(organization.slug)}/billing`
      : null,
    now,
  };
}
