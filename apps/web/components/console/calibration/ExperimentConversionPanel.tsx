import type {
  ComparedArm,
  ExperimentArmConversionMetrics,
  ExperimentConversionSummary,
} from "@/lib/synthesis/experiments/types";

type ConversionArm = Pick<ComparedArm, "arm" | "conversion">;

export function ExperimentConversionPanel({
  arms,
  summary,
}: {
  arms: readonly ConversionArm[];
  summary: ExperimentConversionSummary;
}) {
  return (
    <section aria-labelledby="experiment-conversion-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow">Conversion telemetry</div>
          <h2
            id="experiment-conversion-title"
            className="mt-1 font-display text-lg font-semibold tracking-tight text-cream"
          >
            Outcomes &amp; invocations
          </h2>
        </div>
        <p className="max-w-xl text-pretty text-left text-xs leading-relaxed text-warm-muted sm:text-right">
          Delayed outcomes and later tool use, attributed to the arm that actually served.
        </p>
      </div>

      <dl className="card-enter mt-3 grid overflow-hidden rounded-2xl border border-forest-300 bg-forest-300 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryMetric
          label="Overall attribution"
          value={formatPercent(summary.invocationAttributionRate)}
          detail={`${formatCount(summary.attributedInvocationCount)} of ${formatCount(summary.invocationCount)} invocations`}
          tone="green"
        />
        <SummaryMetric
          label="Attributed invocations"
          value={formatCount(summary.attributedInvocationCount)}
          detail="Matched to a recent selection"
          tone="indigo"
        />
        <SummaryMetric
          label="Unattributed invocations"
          value={formatCount(summary.unattributedInvocationCount)}
          detail="No selection inside the configured window"
          tone="coral"
        />
        <SummaryMetric
          label="Unresolved outcomes"
          value={formatCount(summary.unresolvedOutcomeCount)}
          detail="Selection has no serving results row"
          tone="coral"
        />
      </dl>

      <div className="mt-3 grid gap-3 xl:grid-cols-2">
        {arms.map((arm, index) => (
          <ArmConversionCard
            key={arm.arm}
            arm={arm.arm}
            metrics={arm.conversion ?? null}
            delayMs={Math.min(index, 4) * 60}
          />
        ))}
      </div>
    </section>
  );
}

function ArmConversionCard({
  arm,
  metrics,
  delayMs,
}: {
  arm: string;
  metrics: ExperimentArmConversionMetrics | null;
  delayMs: number;
}) {
  return (
    <article
      className="card-enter overflow-hidden rounded-2xl border border-forest-300 bg-forest-600/35"
      style={{ animationDelay: `${delayMs}ms` }}
    >
      <header className="flex items-center justify-between gap-3 border-b border-forest-300 bg-base-deep/25 px-4 py-3">
        <div className="min-w-0">
          <div className="font-mono text-[9px] uppercase tracking-[0.09em] text-warm-muted">
            Effective arm
          </div>
          <h3 className="mt-0.5 truncate font-mono text-xs font-medium text-cream" title={arm}>
            {arm}
          </h3>
        </div>
        <span className="rounded-full border border-green/25 bg-green/8 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.08em] text-green">
          served
        </span>
      </header>

      <div className="grid divide-y divide-forest-300/55 md:grid-cols-2 md:divide-x md:divide-y-0">
        <OutcomeReadout metrics={metrics} />
        <InvocationReadout metrics={metrics} />
      </div>
    </article>
  );
}

function OutcomeReadout({ metrics }: { metrics: ExperimentArmConversionMetrics | null }) {
  const count = metrics?.outcomeCount ?? 0;
  return (
    <div className="min-w-0 px-4 py-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-warm-muted">Outcomes</div>
          <div className="mt-0.5 font-display text-2xl font-semibold tabular-nums text-cream">
            {formatCount(count)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] text-warm-muted">Average score</div>
          <div className="mt-0.5 font-mono text-sm font-medium tabular-nums text-cream">
            {formatDecimal(metrics?.averageOutcomeScore ?? null)}
          </div>
        </div>
      </div>

      {count === 0 ? (
        <EmptyMetric>No outcomes reported</EmptyMetric>
      ) : (
        <Distribution
          caption="How they resolved"
          rows={[
            ...Object.entries(metrics?.outcomesByLabel ?? {})
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([label, labelCount]) => ({
                key: label,
                label,
                count: labelCount,
                tone: "neutral" as const,
              })),
            ...((metrics?.unlabeledOutcomeCount ?? 0) > 0
              ? [
                  {
                    key: "__unlabeled",
                    label: "Unlabeled",
                    count: metrics?.unlabeledOutcomeCount ?? 0,
                    tone: "muted" as const,
                  },
                ]
              : []),
          ]}
          total={count}
        />
      )}
    </div>
  );
}

function InvocationReadout({ metrics }: { metrics: ExperimentArmConversionMetrics | null }) {
  const count = metrics?.invocationCount ?? 0;
  return (
    <div className="min-w-0 px-4 py-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-warm-muted">Invocations</div>
          <div className="mt-0.5 font-display text-2xl font-semibold tabular-nums text-cream">
            {formatCount(count)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] text-warm-muted">Average age</div>
          <div className="mt-0.5 font-mono text-sm font-medium tabular-nums text-cream">
            {formatDuration(metrics?.averageInvocationAgeMs ?? null)}
          </div>
        </div>
      </div>

      {count === 0 ? (
        <EmptyMetric>No invocations reported</EmptyMetric>
      ) : (
        <Distribution
          caption="Where the capability sat in the results this arm served"
          rows={Object.entries(metrics?.invocationRankHistogram ?? {})
            .sort(([left], [right]) => Number(left) - Number(right))
            .map(([rank, rankCount]) => ({
              key: rank,
              label: rankLabel(Number(rank)),
              count: rankCount,
              tone: rank === "-1" ? ("coral" as const) : ("neutral" as const),
            }))}
          total={count}
        />
      )}
    </div>
  );
}

function SummaryMetric({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: "green" | "indigo" | "coral";
}) {
  const toneClass = {
    green: "text-green",
    indigo: "text-indigo-300",
    coral: "text-coral",
  }[tone];
  return (
    <div className="border-b border-forest-300 bg-base-deep/35 px-4 py-3 last:border-b-0 sm:[&:nth-last-child(-n+2)]:border-b-0 xl:border-b-0 xl:border-r xl:last:border-r-0">
      <dt className="text-[10px] text-warm-muted">{label}</dt>
      <dd className={`mt-0.5 font-display text-xl font-semibold tabular-nums ${toneClass}`}>
        {value}
      </dd>
      <div className="mt-0.5 text-[9px] leading-relaxed text-warm-muted">{detail}</div>
    </div>
  );
}

interface DistributionRow {
  key: string;
  label: string;
  count: number;
  tone: "neutral" | "muted" | "coral";
}

/**
 * A small ranked distribution: label, proportional bar, count, share.
 *
 * These were chips reading `Rank 1 · 4` — a label, a separator and a number,
 * with nothing to say whether four was most of the invocations or almost none
 * of them. Comparing rows meant reading every chip and doing the arithmetic. A
 * bar answers "where did most of them land" at a glance, and the count and
 * share stay on the row for the exact figure.
 */
function Distribution({
  caption,
  rows,
  total,
}: {
  caption: string;
  rows: readonly DistributionRow[];
  total: number;
}) {
  if (rows.length === 0) return null;
  const peak = Math.max(...rows.map((row) => row.count), 1);
  const barTone: Record<DistributionRow["tone"], string> = {
    neutral: "bg-cream/45",
    muted: "bg-forest-300",
    coral: "bg-coral/70",
  };
  const labelTone: Record<DistributionRow["tone"], string> = {
    neutral: "text-cream-dim",
    muted: "text-warm-muted",
    coral: "text-coral",
  };

  return (
    <div className="mt-3">
      <div className="text-[10px] leading-relaxed text-warm-muted">{caption}</div>
      <dl className="mt-2 flex flex-col gap-1">
        {rows.map((row) => (
          <div key={row.key} className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-2">
            <dt className={`truncate text-[11px] ${labelTone[row.tone]}`} title={row.label}>
              {row.label}
            </dt>
            <dd className="h-1.5 overflow-hidden rounded-full bg-base-deep/60" aria-hidden>
              <div
                className={`h-full rounded-full ${barTone[row.tone]}`}
                style={{ width: `${(row.count / peak) * 100}%` }}
              />
            </dd>
            <dd className="flex items-baseline gap-1.5 font-mono text-[11px] tabular-nums">
              <span className="text-cream">{formatCount(row.count)}</span>
              <span className="w-8 text-right text-[10px] text-warm-muted">
                {formatPercent(total === 0 ? null : row.count / total)}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function EmptyMetric({ children }: { children: string }) {
  return (
    <p className="mt-3 rounded-lg border border-dashed border-forest-300 bg-base-deep/20 px-3 py-2 text-[10px] text-warm-muted">
      {children}
    </p>
  );
}

function formatPercent(value: number | null): string {
  return value === null
    ? "—"
    : `${(value * 100).toLocaleString("en-US", {
        maximumFractionDigits: 1,
      })}%`;
}

function formatDecimal(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatDuration(value: number | null): string {
  return value === null ? "—" : `${value.toLocaleString("en-US", { maximumFractionDigits: 1 })} ms`;
}

/**
 * Ranks arrive 0-based from the wire; readers count from one. `-1` is the
 * distinct case of invoking something the search never returned at all, which
 * is not a position and shouldn't be labelled like one.
 */
function rankLabel(rank: number): string {
  return rank === -1 ? "Not in results" : `Position ${rank + 1}`;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}
