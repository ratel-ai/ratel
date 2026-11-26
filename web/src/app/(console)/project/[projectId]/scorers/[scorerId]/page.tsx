import { notFound } from "next/navigation";
import { ScorerDetail } from "@/components/console/scorers/ScorerDetail";
import { ScorerPickerProvider } from "@/components/console/scorers/ScorerPickerProvider";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { parseProjectUuid } from "@/lib/console/scope/cookie";
import { listDashboards } from "@/lib/views/dashboards/store";
import { definitionSummary, hasVerdict } from "@/lib/views/scorers/format";
import { loadScorerPicker } from "@/lib/views/scorers/picker";
import { getScorer, latestScores, scorerSummaries, scorerTrend } from "@/lib/views/scorers/store";
import { dashboardsEnabled } from "../../dashboards/context";
import { resolveScorersPage } from "../context";
import { loadTaskOptions } from "../tasks";

export const dynamic = "force-dynamic";
export const metadata = { title: "Scorer" };

const DAY_MS = 86_400_000;
const TREND_DAYS = 14;
const LATEST = 50;

/** One scorer: how it goes over 14 days, and its latest results. Old links to a scorer land here; it is edited in a Panel. */
export default async function ScorerPage({
  params,
}: {
  params: Promise<{ projectId: string; scorerId: string }>;
}) {
  const { projectId: rawProjectId, scorerId } = await params;
  const page = await resolveScorersPage(rawProjectId);
  if (!page)
    return (
      <DatabaseUnavailable title="Scorer">
        Scorers need a database. Set DATABASE_URL to connect one.
      </DatabaseUnavailable>
    );
  const { projectId } = page;
  const id = parseProjectUuid(scorerId);
  const scorer = id ? await getScorer(projectId, id) : null;
  if (!scorer) notFound();

  const now = new Date();
  const days = Array.from({ length: TREND_DAYS }, (_, index) =>
    new Date(now.getTime() - (TREND_DAYS - 1 - index) * DAY_MS).toISOString().slice(0, 10),
  );
  const [trend, summaries, latest, dashboards, tasks, picker] = await Promise.all([
    scorerTrend(projectId, scorer.id, new Date(`${days[0]}T00:00:00Z`)),
    scorerSummaries(projectId, new Date(now.getTime() - 7 * DAY_MS)),
    latestScores(projectId, scorer.id, LATEST),
    dashboardsEnabled(projectId).then((on) => (on ? listDashboards(projectId) : null)),
    scorer.tasks?.length ? loadTaskOptions(projectId, scorer.tasks) : [],
    loadScorerPicker(projectId, now),
  ]);
  const byDay = new Map(trend.map((row) => [row.day, row]));
  return (
    <ScorerPickerProvider projectId={projectId} data={picker}>
      <ScorerDetail
        projectId={projectId}
        dashboards={dashboards?.map(({ id, name }) => ({ id, name })) ?? null}
        scorer={{
          id: scorer.id,
          name: scorer.name,
          kind: scorer.kind,
          summary: definitionSummary(scorer),
          verdict: hasVerdict(scorer),
          sampleRate: scorer.sampleRate,
          tasks:
            scorer.tasks?.map((id) => ({
              id,
              name: tasks.find((task) => task.id === id)?.name ?? id,
            })) ?? null,
          enabled: scorer.enabled,
          week: summaries.get(scorer.id) ?? null,
        }}
        trend={days.map((day) => {
          const row = byDay.get(day);
          return {
            day,
            scored: row?.scored ?? 0,
            value: row ? (hasVerdict(scorer) ? row.passRate : row.average) : null,
          };
        })}
        latest={latest.map((row) => ({
          ...row,
          traceStartedAt: row.traceStartedAt.toISOString(),
          scoredAt: row.scoredAt.toISOString(),
        }))}
        now={now.toISOString()}
      />
    </ScorerPickerProvider>
  );
}
