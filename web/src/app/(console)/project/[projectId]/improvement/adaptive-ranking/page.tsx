import { RankingView } from "@/components/console/adaptive-ranking/RankingView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { isDbConfigured } from "@/lib/platform/db/client";
import { loadRanking } from "./data";

export const metadata = { title: "Adaptive ranking" };

export default async function AdaptiveRankingPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Adaptive ranking">
        Adaptive ranking becomes available once setup finishes.
      </DatabaseUnavailable>
    );
  }

  const { projectId } = await params;
  // The ranking feature alone, for the graph in `?graph=` or the merged one.
  // What the graph learned is drawn in Intents.
  const requested = (await searchParams).graph;
  const data = await loadRanking({
    projectId,
    graphKey: (Array.isArray(requested) ? requested[0] : requested) ?? null,
    fromPath: false,
  });
  return (
    <RankingView
      title="Adaptive ranking"
      crumbs={[
        {
          label: "Improvements",
          href: `/project/${encodeURIComponent(data.projectId)}/improvement`,
        },
      ]}
      choices={data.choices}
      defaultKey={data.defaultKey}
      graph={data.graph}
      intentsHref={data.intentsHref}
      emptyChecklist={data.emptyChecklist}
    />
  );
}
