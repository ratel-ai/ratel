import { redirect } from "next/navigation";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { getAgentHealthLimits } from "@/lib/platform/entitlements";
import {
  parseSentimentQuery,
  parseSentimentWindow,
  rootCausesHref,
} from "@/lib/views/traces/sentiment/page-paths";

export const dynamic = "force-dynamic";

/**
 * Root cause analysis is a panel of Agent health: its old address opens it
 * there, with its window, filters and sort.
 */
export default async function RootCauseAnalysisPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const { project, organization } = await getProjectScope(projectId);
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
    }),
  );
}
