import { notFound } from "next/navigation";
import { SentimentView } from "@/components/console/sentiment/SentimentView";
import { loadPanelTurn } from "@/components/console/turn-panel/load";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getAgentHealthLimits } from "@/lib/platform/entitlements";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { sentimentAnalysisEnabled } from "@/lib/readings/trace-signals/outcomes/gate";
import { windowOptionsForPlan } from "@/lib/readings/trace-signals/view";
import {
  loadRootCauses,
  loadSentimentPage,
  sentimentMinSessions,
} from "@/lib/views/traces/sentiment/page-load";
import { unavailableSentimentPage } from "@/lib/views/traces/sentiment/page-model";
import {
  parseRootCauseQuery,
  parseSentimentQuery,
  parseSentimentWindow,
  sentimentHref,
} from "@/lib/views/traces/sentiment/page-paths";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sentiment analysis" };

/**
 * Traces, Sentiment analysis (RC-357): how people took the agent's work, by
 * task status, cause, intent and day. 404 unless `cloud-sentiment-analysis`
 * is on for the project's organization. Window and filters live in the URL.
 *
 * Owned (ADR-0004): the project comes from the console scope, and the switch is
 * the core's `sentimentAnalysis` (`FF_SENTIMENT_ANALYSIS`), off by default.
 */
export default async function SentimentAnalysisPage({
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
    operation: "sentiment_page",
    distinctId: `project:${project.id}`,
    fallback: unavailableSentimentPage(project.id, windowDays, query, sentimentMinSessions()),
    load: () => loadSentimentPage({ projectId: project.id, windowDays, query, now }),
  });

  const windows = windowOptionsForPlan(limits.agentHealthWindowDays)
    .filter((option) => !option.locked)
    .map((option) => ({
      href: sentimentHref(project.id, {
        days: option.days,
        filters: query.filters,
        sort: query.sort,
        thin: query.thin,
      }),
      label: `${option.days} days`,
      active: option.days === windowDays,
    }));

  // Root cause analysis, opened over this page: read only then.
  const rootCauseQuery = parseRootCauseQuery(search);
  const rootCauses = rootCauseQuery
    ? await loadOrFallback({
        operation: "sentiment_root_causes",
        distinctId: `project:${project.id}`,
        fallback: unavailableSentimentPage(
          project.id,
          windowDays,
          rootCauseQuery,
          sentimentMinSessions(),
        ),
        load: () =>
          loadRootCauses({ projectId: project.id, windowDays, query: rootCauseQuery, now }),
      })
    : null;
  const turn = await loadPanelTurn({
    projectId: project.id,
    organization,
    search,
    operation: "sentiment_turn",
  });

  return (
    <SentimentView
      model={model}
      windows={windows}
      now={now.toISOString()}
      turn={turn}
      rootCauses={rootCauses}
    />
  );
}
