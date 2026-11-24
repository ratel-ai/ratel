import { notFound } from "next/navigation";
import { RootCauseView } from "@/components/console/sentiment/RootCauseView";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getAgentHealthLimits } from "@/lib/platform/entitlements";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { sentimentAnalysisEnabled } from "@/lib/readings/trace-signals/outcomes/gate";
import { windowOptionsForPlan } from "@/lib/readings/trace-signals/view";
import { loadSentimentPage } from "@/lib/views/traces/sentiment/page-load";
import { unavailableSentimentPage } from "@/lib/views/traces/sentiment/page-model";
import {
  parseSentimentQuery,
  parseSentimentWindow,
  sentimentHref,
} from "@/lib/views/traces/sentiment/page-paths";

export const dynamic = "force-dynamic";
export const metadata = { title: "Root cause analysis" };

/**
 * Agent health, Root cause analysis: why tasks were not completed, and what
 * got in the way of the ones completed after friction, each reason with its
 * root causes ranked by tasks, cost or time. Task completion on the Summary
 * opens it. 404 unless `cloud-sentiment-analysis` is on for the project's
 * organization; the window, filters and sort live in the URL.
 *
 * Owned (ADR-0004): the project comes from the console scope, and the switch is
 * the core's `sentimentAnalysis` (`FF_SENTIMENT_ANALYSIS`), off by default.
 */
export default async function RootCauseAnalysisPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isDbConfigured()) notFound();
  const { projectId } = await params;
  const { project, organization } = await getProjectScope(projectId);
  if (!(await sentimentAnalysisEnabled(organization))) notFound();

  const search = await searchParams;
  const limits = getAgentHealthLimits(organization);
  const windowDays = parseSentimentWindow(search.days, limits.agentHealthWindowDays);
  const query = parseSentimentQuery(search);
  const now = new Date();

  const model = await loadOrFallback({
    operation: "root_cause_page",
    distinctId: `project:${project.id}`,
    fallback: unavailableSentimentPage(project.id, windowDays, query),
    load: () => loadSentimentPage({ projectId: project.id, windowDays, query, now }),
  });

  const windows = windowOptionsForPlan(limits.agentHealthWindowDays)
    .filter((option) => !option.locked)
    .map((option) => ({
      href: sentimentHref(project.id, {
        days: option.days,
        filters: query.filters,
        sort: query.sort,
        surface: "root-causes",
      }),
      label: `${option.days} days`,
      active: option.days === windowDays,
    }));

  return <RootCauseView model={model} windows={windows} now={now.toISOString()} />;
}
