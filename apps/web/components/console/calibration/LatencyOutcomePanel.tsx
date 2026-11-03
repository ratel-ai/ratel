import { cn } from "@ratel/design-system/cn";
import { DeltaChip } from "@/components/console/calibration/DeltaChip";
import type {
  ArmPairAgreementSummary,
  ArmSideStats,
} from "@/lib/synthesis/experiments/calibration-types";
import { latencyDelta, outcomeTone } from "@/lib/synthesis/traces/calibration-view";
import { formatDuration } from "@/lib/synthesis/traces/format";

const TONE_CLASSES = {
  ok: "border-green/25 bg-green/10 text-green",
  warn: "border-ctx-tools/30 bg-ctx-tools/10 text-ctx-tools",
  error: "border-coral/30 bg-coral/10 text-coral",
  muted: "border-forest-300 bg-forest/40 text-warm-muted",
} as const;

/**
 * Served vs shadow latency and outcome split for one comparison pair, read from
 * the census comparison records (immune to trace sampling). The shadow column
 * carries deltas against the served baseline.
 */
export function LatencyOutcomePanel({
  pair,
  headingId = "latency-outcome-title",
  showPairLabel = false,
}: {
  pair: ArmPairAgreementSummary;
  headingId?: string;
  showPairLabel?: boolean;
}) {
  return (
    <section aria-labelledby={headingId}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow">Latency &amp; outcomes</div>
          <h2
            id={headingId}
            className="mt-1 font-display text-lg font-semibold tracking-tight text-cream"
          >
            {showPairLabel ? (
              <>
                <span className="font-mono">{pair.servedArm}</span>
                <span className="text-warm-muted"> served · </span>
                <span className="font-mono">{pair.shadowArm}</span>
                <span className="text-warm-muted"> shadow</span>
              </>
            ) : (
              "Served vs shadow"
            )}
          </h2>
        </div>
        <p className="max-w-xl text-pretty text-left text-xs leading-relaxed text-warm-muted sm:text-right">
          Census metrics from comparison records — every shadow-tested request counts, even when its
          trace was not sampled.
        </p>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <SideCard
          title={pair.servedArm}
          role="served"
          stats={pair.served}
          baselineStats={null}
          index={0}
        />
        <SideCard
          title={pair.shadowArm}
          role="shadow"
          stats={pair.shadow}
          baselineStats={pair.served}
          index={1}
        />
      </div>
    </section>
  );
}

function SideCard({
  title,
  role,
  stats,
  baselineStats,
  index,
}: {
  title: string;
  role: "served" | "shadow";
  stats: ArmSideStats;
  baselineStats: ArmSideStats | null;
  index: number;
}) {
  return (
    <article
      className="card-enter overflow-hidden rounded-2xl border border-forest-300 bg-forest-600/45"
      style={{ animationDelay: `${index * 80}ms` }}
    >
      <header className="flex items-center gap-3 border-b border-forest-300 bg-base-deep/30 px-4 py-3">
        <span
          className={cn("size-2 rounded-full", role === "served" ? "bg-coral" : "bg-indigo-300")}
          aria-hidden
        />
        <h3
          className="min-w-0 flex-1 truncate font-mono text-sm font-medium text-cream"
          title={title}
        >
          {title}
        </h3>
        <span className="rounded-md border border-forest-300 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-warm-muted">
          {role}
        </span>
      </header>

      <dl className="divide-y divide-forest-300/55">
        <StatRow
          label="P50 latency"
          value={formatMs(stats.p50DurationMs)}
          delta={baselineStats && latencyDelta(baselineStats.p50DurationMs, stats.p50DurationMs)}
        />
        <StatRow
          label="P95 latency"
          value={formatMs(stats.p95DurationMs)}
          delta={baselineStats && latencyDelta(baselineStats.p95DurationMs, stats.p95DurationMs)}
        />
        <StatRow
          label="Average latency"
          value={formatMs(stats.averageDurationMs)}
          delta={
            baselineStats && latencyDelta(baselineStats.averageDurationMs, stats.averageDurationMs)
          }
        />
        <StatRow
          label="Error rate"
          value={formatRate(stats.errorRate)}
          delta={baselineStats && errorRateDelta(baselineStats, stats)}
          display="percentage-points"
        />
      </dl>

      <div className="border-t border-forest-300/55 px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-wide text-warm-muted">
          Outcomes
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {Object.entries(stats.outcomes).length === 0 ? (
            <span className="font-mono text-[10px] text-warm-muted/60">none recorded</span>
          ) : (
            Object.entries(stats.outcomes)
              .sort(([, left], [, right]) => right - left)
              .map(([outcome, count]) => (
                <span
                  key={outcome}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[10px]",
                    TONE_CLASSES[outcomeTone(outcome)],
                  )}
                >
                  {outcome}
                  <span className="tabular-nums opacity-80">{count.toLocaleString("en-US")}</span>
                </span>
              ))
          )}
        </div>
      </div>
    </article>
  );
}

function StatRow({
  label,
  value,
  delta,
  display,
}: {
  label: string;
  value: string;
  delta: { absolute: number; relative: number | null } | null;
  display?: "percentage-points";
}) {
  return (
    <div className="flex min-h-12 items-center gap-3 px-4 py-2.5">
      <dt className="min-w-0 flex-1 text-xs text-warm-muted">{label}</dt>
      <dd className="flex items-center gap-2 text-right">
        <span className="font-mono text-sm font-medium tabular-nums text-cream">{value}</span>
        {delta !== null && <DeltaChip delta={delta} display={display} />}
      </dd>
    </div>
  );
}

function errorRateDelta(
  baseline: ArmSideStats,
  stats: ArmSideStats,
): { absolute: number; relative: number | null } | null {
  if (baseline.errorRate === null || stats.errorRate === null) return null;
  const absolute = stats.errorRate - baseline.errorRate;
  return {
    absolute,
    relative: baseline.errorRate === 0 ? null : absolute / baseline.errorRate,
  };
}

function formatMs(value: number | null): string {
  return value === null ? "—" : formatDuration(value);
}

function formatRate(value: number | null): string {
  return value === null
    ? "—"
    : `${(value * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
}
