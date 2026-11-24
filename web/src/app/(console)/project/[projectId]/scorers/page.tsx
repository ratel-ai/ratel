import { ScorersList } from "@/components/console/scorers/ScorersList";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { definitionSummary, hasVerdict } from "@/lib/views/scorers/format";
import { listScorers, scorerSummaries } from "@/lib/views/scorers/store";
import { resolveScorersPage } from "./context";

export const dynamic = "force-dynamic";
export const metadata = { title: "Scorers" };

const WEEK_MS = 7 * 86_400_000;

/** A project's scorers with what they measured in the last 7 days. */
export default async function ScorersPage({ params }: { params: Promise<{ projectId: string }> }) {
  const page = await resolveScorersPage((await params).projectId);
  if (!page)
    return (
      <DatabaseUnavailable title="Scorers">
        Scorers need a database. Set DATABASE_URL to connect one.
      </DatabaseUnavailable>
    );
  const { projectId } = page;
  const [scorers, summaries] = await Promise.all([
    listScorers(projectId),
    scorerSummaries(projectId, new Date(Date.now() - WEEK_MS)),
  ]);
  return (
    <ScorersList
      projectId={projectId}
      scorers={scorers.map((scorer) => ({
        id: scorer.id,
        name: scorer.name,
        kind: scorer.kind,
        summary: definitionSummary(scorer),
        verdict: hasVerdict(scorer),
        sampleRate: scorer.sampleRate,
        enabled: scorer.enabled,
        week: summaries.get(scorer.id) ?? null,
      }))}
    />
  );
}
