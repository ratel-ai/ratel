import { notFound } from "next/navigation";
import { ComparisonBrowser } from "@/components/console/calibration/ComparisonBrowser";
import { DateRangeControl } from "@/components/console/calibration/DateRangeControl";
import { BackLink } from "@/components/console/traces/compare/BackLink";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { createCalibrationQueries } from "@/lib/synthesis/experiments/calibration-queries";
import { createCalibrationService } from "@/lib/synthesis/experiments/calibration-service";
import type { RankingCalibrationView } from "@/lib/synthesis/experiments/calibration-types";
import {
  calibrationDetailPath,
  resolveComparisonBrowserView,
  singleSearchParam,
} from "@/lib/synthesis/traces/calibration-view";
import { experimentNameFromPathSegment } from "@/lib/synthesis/traces/experiment-view";
import { resolveTraceListView, type TraceListSearchParams } from "@/lib/synthesis/traces/view";

export const metadata = { title: "Calibration mismatches" };

/** Owned (ADR-0030): the project comes from the guarded route, a 404 outside the organization. */
export default async function CalibrationMismatchesPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; name: string }>;
  searchParams: Promise<TraceListSearchParams>;
}) {
  if (!isDbConfigured()) notFound();

  const [{ projectId, name: nameSegment }, query] = await Promise.all([params, searchParams]);

  const name = experimentNameFromPathSegment(nameSegment);
  const { project } = await requireProjectScope(projectId);
  const view = resolveTraceListView({ ...query, project: project.slug });
  const comparisonSearch = {
    comparisons: singleSearchParam(query.comparisons),
    comparisonMatch: singleSearchParam(query.comparisonMatch),
    comparisonPage: singleSearchParam(query.comparisonPage),
    comparisonPageSize: singleSearchParam(query.comparisonPageSize),
  };
  const comparisonView = resolveComparisonBrowserView(comparisonSearch);
  const calibration = await loadOrFallback({
    operation: "calibration_mismatches_view",
    distinctId: `project:${project.id}`,
    fallback: null as RankingCalibrationView | null,
    load: () =>
      withStatementTimeout((db) =>
        createCalibrationService(createCalibrationQueries(db)).getRankingCalibration(
          project.id,
          name,
          { since: view.range.since, until: view.range.until },
          {
            selection: comparisonView.selection,
            limit: comparisonView.pageSize,
            offset: comparisonView.offset,
          },
        ),
      ),
  });
  if (!calibration) notFound();

  const boundedView = resolveComparisonBrowserView(
    comparisonSearch,
    calibration.filteredComparisonCount,
  );
  const basePath = `/project/${project.id}/calibration`;
  const rangeSearch = rangeParams(project.slug, view);
  const backHref = `${calibrationDetailPath(basePath, name)}?${rangeSearch.toString()}`;

  return (
    <div className="flex flex-col gap-7">
      <div className="pixel-header card-enter flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <BackLink href={backHref}>Back to {name}</BackLink>
          <div className="mt-4 eyebrow">Calibration mismatches</div>
          <h1 className="mt-1.5 break-words font-display text-2xl font-bold tracking-tight text-cream">
            {name}
          </h1>
          <p className="mt-1.5 text-sm text-warm-muted">
            {calibration.mismatchCount.toLocaleString("en-US")} flagged of{" "}
            {calibration.totalComparisonCount.toLocaleString("en-US")} comparisons
          </p>
        </div>
        <DateRangeControl
          preset={view.range.preset}
          from={view.range.from}
          to={view.range.to}
          preserveLiveParams
        />
      </div>

      <ComparisonBrowser
        key={rangeSearch.toString()}
        initialPage={{
          rows: calibration.comparisons,
          total: calibration.filteredComparisonCount,
        }}
        initialView={boundedView}
        projectId={project.id}
        experimentName={name}
        basePath={basePath}
        rangeSearch={rangeSearch.toString()}
      />
    </div>
  );
}

function rangeParams(
  projectSlug: string,
  view: ReturnType<typeof resolveTraceListView>,
): URLSearchParams {
  const search = new URLSearchParams({
    project: projectSlug,
    range: view.range.preset,
  });
  if (view.range.preset === "custom") {
    search.set("from", view.range.from);
    search.set("to", view.range.to);
  }
  return search;
}
