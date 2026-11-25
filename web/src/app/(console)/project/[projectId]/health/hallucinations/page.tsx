import { notFound } from "next/navigation";
import { HallucinationsView } from "@/components/console/hallucinations/HallucinationsView";
import { loadPanelTurn } from "@/components/console/turn-panel/load";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getAgentHealthLimits } from "@/lib/platform/entitlements";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { hallucinationDetectionEnabled } from "@/lib/readings/trace-signals/hallucinations/gate";
import { windowOptionsForPlan } from "@/lib/readings/trace-signals/view";
import { loadHallucinationsPage } from "@/lib/views/health/hallucinations/page-load";
import { unavailableHallucinationsPage } from "@/lib/views/health/hallucinations/page-model";
import {
  hallucinationsHref,
  parseHallucinationsQuery,
  parseHallucinationsWindow,
} from "@/lib/views/health/hallucinations/paths";

export const dynamic = "force-dynamic";
export const metadata = { title: "Hallucinations" };

/**
 * Agent health, Hallucinations: what the agent made up (a tool that does not
 * exist, an input that does not, work it said was done), by group with each
 * group's share, each kind opening its tools and its calls in Traces. 404
 * unless `hallucinationDetection` is on for the project's
 * organization. The window, the group and the open kind live in the URL.
 *
 * Owned (ADR-0004): the project comes from the console scope, and the switch is
 * the core's `hallucinationDetection` (`FF_HALLUCINATION_DETECTION`), off by default.
 */
export default async function HallucinationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isDbConfigured()) notFound();
  const { projectId } = await params;
  const { project, organization } = await getProjectScope(projectId);
  if (!(await hallucinationDetectionEnabled(organization))) notFound();

  const search = await searchParams;
  const limits = getAgentHealthLimits(organization);
  const windowDays = parseHallucinationsWindow(search.days, limits.agentHealthWindowDays);
  const query = parseHallucinationsQuery(search);
  const now = new Date();

  const model = await loadOrFallback({
    operation: "hallucinations_page",
    distinctId: `project:${project.id}`,
    fallback: unavailableHallucinationsPage(project.id, windowDays, query),
    load: () => loadHallucinationsPage({ projectId: project.id, windowDays, query, now }),
  });

  const windows = windowOptionsForPlan(limits.agentHealthWindowDays)
    .filter((option) => !option.locked)
    .map((option) => ({
      href: hallucinationsHref(project.id, {
        days: option.days,
        group: query.group,
        kind: query.kind,
      }),
      label: `${option.days} days`,
      active: option.days === windowDays,
    }));

  const turn = await loadPanelTurn({
    projectId: project.id,
    organization,
    search,
    operation: "hallucinations_turn",
  });

  return <HallucinationsView model={model} windows={windows} now={now.toISOString()} turn={turn} />;
}
