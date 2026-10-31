import { notFound } from "next/navigation";
import { RankingView } from "@/components/console/adaptive-ranking/RankingView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { isDbConfigured } from "@/lib/platform/db/client";
import { loadRanking } from "../data";

export const metadata = { title: "Intent graph" };

function decodeGraphKey(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export default async function IntentGraphDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; graphKey: string }>;
}) {
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Adaptive ranking">
        Adaptive ranking becomes available once setup finishes.
      </DatabaseUnavailable>
    );
  }

  const { projectId, graphKey: rawGraphKey } = await params;
  const graphKey = decodeGraphKey(rawGraphKey);
  if (graphKey === null || graphKey.length === 0) notFound();
  // This graph's ranking alone; its map is in Intents, not here.
  const data = await loadRanking({ projectId, graphKey, fromPath: true });
  const root = `/project/${encodeURIComponent(data.projectId)}/improvement`;
  return (
    <RankingView
      title={data.graph?.choice.label ?? graphKey}
      crumbs={[
        { label: "Improvements", href: root },
        { label: "Adaptive ranking", href: `${root}/adaptive-ranking` },
      ]}
      choices={[]}
      defaultKey={data.defaultKey}
      graph={data.graph}
      intentsHref={data.intentsHref}
      emptyChecklist={data.emptyChecklist}
    />
  );
}
