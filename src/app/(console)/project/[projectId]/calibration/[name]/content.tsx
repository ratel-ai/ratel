import { notFound } from "next/navigation";
import { ArmComparisonGrid } from "@/components/console/calibration/ArmComparisonGrid";
import { CapabilityRankDiffTable } from "@/components/console/calibration/CapabilityRankDiffTable";
import { DateRangeControl } from "@/components/console/calibration/DateRangeControl";
import { ExperimentConversionPanel } from "@/components/console/calibration/ExperimentConversionPanel";
import { ExperimentIssuesPanel } from "@/components/console/calibration/ExperimentIssuesPanel";
import { ExperimentLifecyclePanels } from "@/components/console/calibration/ExperimentLifecyclePanels";
import { BackLink } from "@/components/console/traces/compare/BackLink";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { createExperimentService } from "@/lib/synthesis/experiments/service";
import { loadExperimentDetailSurface } from "@/lib/synthesis/experiments/surface-loaders";
import { createExperimentQueries } from "@/lib/synthesis/traces/experiment-queries";
import {
  experimentNameFromPathSegment,
  selectVisibleArms,
} from "@/lib/synthesis/traces/experiment-view";
import { resolveTraceListView, type TraceListSearchParams } from "@/lib/synthesis/traces/view";

type ExperimentDetailSurface = "experiments" | "calibration";

const SURFACE_COPY: Record<
  ExperimentDetailSurface,
  {
    backLabel: string;
    eyebrow: string;
    unavailable: string;
  }
> = {
  experiments: {
    backLabel: "All experiments",
    eyebrow: "Experiment comparison",
    unavailable:
      "No database connected yet. Experiment comparison becomes available once setup finishes.",
  },
  calibration: {
    backLabel: "All calibration experiments",
    eyebrow: "Calibration experiment",
    unavailable:
      "No database connected yet. Calibration comparison becomes available once setup finishes.",
  },
};

export const metadata = { title: "Experiment comparison" };

/**
 * The span-aggregate experiment comparison: arms against the baseline, findings,
 * shadow reliability, conversion and the capability rank diff. The calibration
 * detail renders it for experiments without comparison records.
 *
 * Owned (ADR-0030): the project comes from the guarded route, a 404 outside the
 * organization. Upstream also mounts this under its organization-wide
 * Experiments page, which is not part of this edition, so a project is always
 * given.
 */
export default async function ExperimentDetailContent({
  params,
  searchParams,
  projectId,
  surface = "experiments",
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<TraceListSearchParams>;
  projectId: string;
  surface?: ExperimentDetailSurface;
}) {
  const copy = SURFACE_COPY[surface];

  if (!isDbConfigured()) {
    return (
      <p className="rounded-lg border border-coral/40 bg-coral/10 p-3 font-mono text-xs text-cream-dim">
        {copy.unavailable}
      </p>
    );
  }

  const [{ name: nameSegment }, query] = await Promise.all([params, searchParams]);
  const name = experimentNameFromPathSegment(nameSegment);
  const { project } = await requireProjectScope(projectId);
  const scopedParams = { ...query, project: project.slug };
  const view = resolveTraceListView(scopedParams);
  const window = {
    since: view.range.since,
    until: view.range.until,
  };
  const supplementaryTimeoutMs = supplementaryReadTimeoutMs();
  const comparison = await loadExperimentDetailSurface(
    { distinctId: `project:${project.id}` },
    {
      loadComparison: () =>
        withStatementTimeout(
          (db) =>
            createExperimentService(createExperimentQueries(db)).getExperimentComparison(
              project.id,
              name,
              window,
            ),
          { operation: "experiment_comparison" },
        ),
      loadLifecycle: () =>
        withStatementTimeout(
          (db) =>
            createExperimentService(createExperimentQueries(db)).getExperimentLifecycle(
              project.id,
              name,
              window,
            ),
          {
            operation: "experiment_lifecycle",
            timeoutMs: supplementaryTimeoutMs,
          },
        ),
      loadConversion: () =>
        withStatementTimeout(
          (db) =>
            createExperimentService(createExperimentQueries(db)).getExperimentConversion(
              project.id,
              name,
              window,
            ),
          {
            operation: "experiment_conversion",
            timeoutMs: supplementaryTimeoutMs,
          },
        ),
    },
  );
  if (!comparison) notFound();

  const experimentIndexHref = experimentsHref(
    project.slug,
    view.range.preset,
    view.range.from,
    view.range.to,
    projectId ? `/project/${project.id}/calibration` : "/experiments",
  );
  const traceRoot = projectId ? `/project/${project.id}/traces` : "/traces";
  const visibleArms = selectVisibleArms(comparison.arms, comparison.baselineArm);

  return (
    <div className="flex flex-col gap-6">
      <div className="pixel-header card-enter flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <BackLink href={experimentIndexHref}>{copy.backLabel}</BackLink>
          {/* No mode tag beside the eyebrow. It named the execution mode and
              nothing else — where the mode changes how these numbers should be
              read, the page says so in words: the notice above Arm comparison,
              the mixed-execution warning below, and whether Shadow agreement
              renders at all. */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="eyebrow">{copy.eyebrow}</span>
          </div>
          <h1 className="mt-1.5 break-words font-display text-2xl font-bold tracking-tight text-cream">
            {comparison.name}
          </h1>
          <p className="mt-1.5 break-words text-sm text-warm-muted [overflow-wrap:anywhere]">
            Baseline{" "}
            <span className="font-mono text-cream-dim [overflow-wrap:anywhere]">
              {comparison.baselineArm}
            </span>
            {" · "}
            {comparison.arms.length} arm
            {comparison.arms.length === 1 ? "" : "s"}
            {" · "}
            {comparison.issues.length} finding
            {comparison.issues.length === 1 ? "" : "s"}
          </p>
        </div>
        <DateRangeControl
          preset={view.range.preset}
          from={view.range.from}
          to={view.range.to}
          unified={Boolean(projectId)}
        />
      </div>

      {comparison.mode === "mixed" && (
        <div className="rounded-xl border border-coral/25 bg-coral/[0.055] px-4 py-3 text-xs leading-relaxed text-cream-dim">
          <span className="font-mono text-[10px] uppercase tracking-wide text-coral">
            Mixed execution
          </span>
          <span className="ml-2">
            Some traces contain multiple arms while others contain one. Aggregate deltas are useful
            for direction, not causal attribution.
          </span>
        </div>
      )}

      <ArmComparisonGrid
        arms={comparison.arms}
        baselineArm={comparison.baselineArm}
        mode={comparison.mode}
      />

      <ExperimentIssuesPanel
        issues={comparison.issues}
        context={{
          experimentName: comparison.name,
          traceRoot,
          project: project.slug,
          range: view.range.preset,
          ...(view.range.preset === "custom" ? { from: view.range.from, to: view.range.to } : {}),
        }}
      />

      {/* Shadow agreement only means anything when an arm actually ran in
          shadow. On a pure split experiment there is nothing to agree with, so
          the panel used to render a "genuine zero, not an ingestion gap" notice
          that reads as a fault rather than as "not applicable here". */}
      {comparison.lifecycleDiagnostics && comparison.mode !== "split" && (
        <ExperimentLifecyclePanels
          metrics={comparison.arms.flatMap(({ lifecycle }) => (lifecycle ? [lifecycle] : []))}
          diagnostics={comparison.lifecycleDiagnostics}
        />
      )}

      {comparison.conversionSummary && (
        <ExperimentConversionPanel
          arms={comparison.arms.map(({ arm, conversion }) => ({
            arm,
            conversion,
          }))}
          summary={comparison.conversionSummary}
        />
      )}

      <CapabilityRankDiffTable
        comparison={comparison.capabilities}
        baselineArm={comparison.baselineArm}
        arms={visibleArms.map(({ arm }) => arm)}
      />
    </div>
  );
}

function experimentsHref(
  projectSlug: string,
  range: string,
  from: string,
  to: string,
  basePath: string,
): string {
  const search = new URLSearchParams({ project: projectSlug, range });
  if (range === "custom") {
    search.set("from", from);
    search.set("to", to);
  }
  return `${basePath}?${search.toString()}`;
}
