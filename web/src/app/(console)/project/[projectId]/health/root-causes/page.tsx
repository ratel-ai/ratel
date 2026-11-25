import { notFound, redirect } from "next/navigation";
import { getAgentHealthLimits } from "@/lib/platform/entitlements";
import {
  parseSentimentQuery,
  parseSentimentWindow,
  rootCausesHref,
} from "@/lib/views/traces/sentiment/page-paths";
import { sentimentPageScope } from "@/lib/views/traces/sentiment/page-scope";

export const dynamic = "force-dynamic";

/**
 * Root cause analysis is a panel of Agent health: its old address opens it
 * there, with its window, filters, sort and the row it named. Behind
 * `sentimentAnalysis` like the panel: with the switch off it is not found.
 */
export default async function RootCauseAnalysisPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const scope = await sentimentPageScope(projectId);
  if (!scope) notFound();
  const { project, organization } = scope;
  const search = await searchParams;
  const query = parseSentimentQuery(search);
  redirect(
    rootCausesHref(project.id, {
      days: parseSentimentWindow(
        search.days,
        getAgentHealthLimits(organization).agentHealthWindowDays,
      ),
      filters: query.filters,
      sort: query.sort,
      open: query.open,
    }),
  );
}
