import Link from "next/link";
import { ArmRoleMix } from "@/components/console/calibration/ArmRoleMix";
import { DateRangeControl } from "@/components/console/calibration/DateRangeControl";
import { RankingExperimentBadge } from "@/components/console/calibration/ExperimentBadge";
import { LatencyOutcomePanel } from "@/components/console/calibration/LatencyOutcomePanel";
import { RankingKpiBand } from "@/components/console/calibration/RankingKpiBand";
import { BackLink } from "@/components/console/traces/compare/BackLink";
import type { RankingCalibrationView } from "@/lib/synthesis/experiments/calibration-types";
import type { ExperimentLifecycleArmMetrics } from "@/lib/synthesis/experiments/types";
import { calibrationMismatchesPath } from "@/lib/synthesis/traces/calibration-view";
import type { TraceListView } from "@/lib/synthesis/traces/view";
import { qualityReportHref, reportWindowDays } from "@/lib/views/quality/report-href";

/**
 * Ranking-shadow calibration detail: census agreement KPIs, served-vs-shadow
 * latency/outcome split, and a link to the dedicated mismatch browser. Rendered
 * when the experiment exports `ratel.experiment.comparison` records
 * (auto-detected; `?view=generic` falls back to the span-aggregate view).
 *
 * Owned (ADR-0030): adds the member's link to the printable Quality report for
 * this calibration and window, which upstream offers only from its admin console.
 */
export function RankingCalibrationContent({
  calibration,
  experimentName,
  basePath,
  projectId,
  projectSlug,
  view,
}: {
  calibration: RankingCalibrationView;
  experimentName: string;
  basePath: string;
  projectId: string;
  projectSlug: string;
  view: TraceListView;
}) {
  const rangeSearch = rangeParams(projectSlug, view);
  const indexHref = `${basePath}?${rangeSearch.toString()}`;
  const mismatchesHref = `${calibrationMismatchesPath(
    basePath,
    experimentName,
  )}?${rangeSearch.toString()}`;
  const reportHref = qualityReportHref(
    projectId,
    experimentName,
    reportWindowDays({ since: view.range.since, until: view.range.until }),
  );

  return (
    <div className="flex flex-col gap-7">
      <div className="pixel-header card-enter flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <BackLink href={indexHref}>All calibration experiments</BackLink>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="eyebrow">Calibration comparison</span>
            <RankingExperimentBadge label="ranking shadow" />
          </div>
          <h1 className="mt-1.5 break-words font-display text-2xl font-bold tracking-tight text-cream">
            {calibration.name}
          </h1>
          <p className="mt-1.5 break-words text-sm text-warm-muted [overflow-wrap:anywhere]">
            {calibration.arms.length.toLocaleString("en-US")} arm
            {calibration.arms.length === 1 ? "" : "s"}
            {" · "}
            {calibration.totalComparisonCount.toLocaleString("en-US")} comparison
            {calibration.totalComparisonCount === 1 ? "" : "s"}
            {" · "}
            {calibration.mismatchCount.toLocaleString("en-US")} mismatch
            {calibration.mismatchCount === 1 ? "" : "es"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={mismatchesHref}
            className="inline-flex min-h-8 items-center gap-2 rounded-lg border border-indigo-300/35 bg-indigo-300/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-indigo-300 transition-colors hover:border-indigo-300/60 hover:bg-indigo-300/15"
          >
            View mismatches
            <span className="tabular-nums text-cream-dim">
              {calibration.mismatchCount.toLocaleString("en-US")}
            </span>
            <span aria-hidden>→</span>
          </Link>
          <Link
            href={reportHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-8 items-center gap-2 rounded-lg border border-coral/40 bg-coral/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-coral transition-colors hover:bg-coral/20"
          >
            Partner report (PDF)
          </Link>
          <DateRangeControl
            preset={view.range.preset}
            from={view.range.from}
            to={view.range.to}
            preserveLiveParams
          />
        </div>
      </div>

      <ArmRoleMix arms={calibration.arms} />

      {calibration.pairs.map((pair) => (
        <RankingKpiBand
          key={`${pair.servedArm}→${pair.shadowArm}`}
          pair={pair}
          shadowCoverage={coverageFor(calibration.lifecycle, pair.shadowArm)}
          showPairLabel={calibration.pairs.length > 1}
        />
      ))}

      {calibration.pairs.map((pair, index) => (
        <LatencyOutcomePanel
          key={`latency:${pair.servedArm}→${pair.shadowArm}`}
          pair={pair}
          headingId={`latency-outcome-title-${index}`}
          showPairLabel={calibration.pairs.length > 1}
        />
      ))}

      <ShadowReliability lifecycle={calibration.lifecycle} />
    </div>
  );
}

function ShadowReliability({ lifecycle }: { lifecycle: ExperimentLifecycleArmMetrics[] }) {
  if (lifecycle.length === 0) return null;
  return (
    <section aria-labelledby="shadow-reliability-title">
      <div className="eyebrow">Shadow reliability</div>
      <h2
        id="shadow-reliability-title"
        className="mt-1 font-display text-lg font-semibold tracking-tight text-cream"
      >
        Comparison funnel
      </h2>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        {lifecycle.map((metrics) => (
          <article
            key={metrics.arm}
            className="rounded-2xl border border-forest-300 bg-forest-600/45 px-4 py-3"
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-medium text-cream" title={metrics.arm}>
                {metrics.arm}
              </span>
              <span className="rounded-md border border-forest-300 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-warm-muted">
                shadow executions
              </span>
            </div>
            <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5 font-mono text-[11px] tabular-nums text-cream-dim">
              <FunnelStat label="comparisons" value={metrics.comparisonCount} />
              <FunnelStat label="skips" value={metrics.skipCount} />
              <FunnelStat label="fallbacks" value={metrics.fallbackCount} />
              <FunnelStat label="drops" value={metrics.dropCount} />
            </dl>
            {Object.keys(metrics.dropsByReason).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(metrics.dropsByReason)
                  .sort(([, left], [, right]) => right - left)
                  .map(([reason, count]) => (
                    <span
                      key={reason}
                      className="inline-flex items-center gap-1.5 rounded-md border border-coral/30 bg-coral/10 px-2 py-0.5 font-mono text-[10px] text-coral"
                    >
                      {reason}
                      <span className="tabular-nums opacity-80">{count}</span>
                    </span>
                  ))}
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function FunnelStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-warm-muted">{label}</dt>
      <dd className="text-cream">{value.toLocaleString("en-US")}</dd>
    </div>
  );
}

function coverageFor(
  lifecycle: ExperimentLifecycleArmMetrics[],
  shadowArm: string | null | undefined,
): number | null {
  if (!shadowArm) return null;
  return lifecycle.find(({ arm }) => arm === shadowArm)?.shadowCoverage ?? null;
}

function rangeParams(projectSlug: string, view: TraceListView): URLSearchParams {
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
