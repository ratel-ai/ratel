import ExperimentDetailContent from "@/app/(console)/project/[projectId]/calibration/[name]/content";
import { RankingCalibrationContent } from "@/app/(console)/project/[projectId]/calibration/[name]/ranking-content";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { createCalibrationQueries } from "@/lib/synthesis/experiments/calibration-queries";
import { createCalibrationService } from "@/lib/synthesis/experiments/calibration-service";
import type {
  ExperimentCalibrationSummary,
  RankingCalibrationView,
} from "@/lib/synthesis/experiments/calibration-types";
import type { ExperimentKind } from "@/lib/synthesis/experiments/ranking";
import { singleSearchParam } from "@/lib/synthesis/traces/calibration-view";
import { experimentNameFromPathSegment } from "@/lib/synthesis/traces/experiment-view";
import { resolveTraceListView, type TraceListSearchParams } from "@/lib/synthesis/traces/view";

export const metadata = { title: "Calibration comparison" };

/** Owned (ADR-0030): the project comes from the guarded route, a 404 outside the organization. */
export default async function ScopedCalibrationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; name: string }>;
  searchParams: Promise<TraceListSearchParams>;
}) {
  const [{ projectId, name: nameSegment }, query] = await Promise.all([params, searchParams]);
  const genericDetail = (
    <ExperimentDetailContent
      projectId={projectId}
      params={Promise.resolve({ name: nameSegment })}
      searchParams={Promise.resolve(query)}
      surface="calibration"
    />
  );
  if (!isDbConfigured()) return genericDetail;

  const name = experimentNameFromPathSegment(nameSegment);
  const { project } = await requireProjectScope(projectId);
  const view = resolveTraceListView({ ...query, project: project.slug });
  const window = { since: view.range.since, until: view.range.until };

  const kind = await resolveKind(query, project.id, name, window);
  if (kind !== "ranking-shadow") return genericDetail;

  const calibration = await loadOrFallback({
    operation: "calibration_ranking_view",
    distinctId: `project:${project.id}`,
    fallback: null as RankingCalibrationView | null,
    load: () =>
      withStatementTimeout((db) =>
        createCalibrationService(createCalibrationQueries(db)).getRankingCalibration(
          project.id,
          name,
          window,
          { limit: 1 },
        ),
      ),
  });
  if (!calibration) return genericDetail;

  return (
    <RankingCalibrationContent
      calibration={calibration}
      experimentName={name}
      basePath={`/project/${project.id}/calibration`}
      projectId={project.id}
      projectSlug={project.slug}
      view={view}
    />
  );
}

/** `?view=` overrides detection so either layout stays reachable. */
async function resolveKind(
  query: TraceListSearchParams,
  projectId: string,
  name: string,
  window: { since: Date; until: Date },
): Promise<ExperimentKind> {
  const override = singleSearchParam(query.view);
  if (override === "generic") return "generic";
  if (override === "ranking") return "ranking-shadow";
  const summaries = await loadOrFallback({
    operation: "calibration_kind_detection",
    distinctId: `project:${projectId}`,
    fallback: new Map<string, ExperimentCalibrationSummary>(),
    load: () =>
      withStatementTimeout((db) =>
        createCalibrationService(createCalibrationQueries(db)).resolveCalibrationSummaries(
          projectId,
          [name],
          window,
        ),
      ),
  });
  return summaries.get(name)?.kind ?? "generic";
}
