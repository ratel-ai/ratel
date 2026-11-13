import { cn } from "@ratel/design-system/cn";
import { DeltaChip, type DeltaDisplay } from "@/components/console/calibration/DeltaChip";
import type { ComparedArm, ExperimentMode, MetricDelta } from "@/lib/synthesis/experiments/types";
import { armRoleLabel, selectVisibleArms } from "@/lib/synthesis/traces/experiment-view";
import { formatCostUsd, formatDuration, formatTokens } from "@/lib/synthesis/traces/format";

const MAX_VISIBLE_ARMS = 3;

const MODE_NOTICE: Record<ExperimentMode, string> = {
  split: "Each trace belongs to one arm. Deltas compare independent populations in this window.",
  shadow: "Arms share traces. Deltas compare work performed under the same top-level runs.",
  mixed: "This window mixes split and shadow execution. Treat aggregate deltas as directional.",
};

interface MetricRow {
  label: string;
  /** Short gloss shown under the label, once per row rather than once per arm. */
  note?: string;
  value: (arm: ComparedArm) => string;
  sub?: (arm: ComparedArm) => string;
  delta?: (arm: ComparedArm) => MetricDelta | null;
  display?: DeltaDisplay;
  /** `null` means neither direction is an improvement — the chip stays neutral. */
  lowerIsBetter?: boolean | null;
}

const METRIC_ROWS: readonly MetricRow[] = [
  {
    label: "Traces",
    note: "sample size",
    value: (arm) => arm.metrics.traceCount.toLocaleString("en-US"),
  },
  {
    label: "Error rate",
    value: (arm) => formatPercent(arm.metrics.errorRate),
    delta: (arm) => arm.deltas?.errorRate ?? null,
    display: "percentage-points",
  },
  {
    label: "P95 latency",
    value: (arm) => formatDuration(arm.metrics.p95LatencyMs),
    delta: (arm) => arm.deltas?.p95LatencyMs ?? null,
  },
  {
    label: "Average latency",
    value: (arm) => formatDuration(arm.metrics.averageLatencyMs),
    delta: (arm) => arm.deltas?.averageLatencyMs ?? null,
  },
  {
    label: "Average tokens",
    note: "in + out",
    value: (arm) => formatTokens(totalTokens(arm)),
    sub: (arm) =>
      `${formatTokens(arm.metrics.averageInputTokens)} in · ${formatTokens(arm.metrics.averageOutputTokens)} out`,
    delta: (arm) =>
      sumDelta(
        arm.deltas?.averageInputTokens ?? null,
        arm.deltas?.averageOutputTokens ?? null,
        totalTokens(arm),
      ),
  },
  {
    label: "Average cost",
    value: (arm) => formatCostUsd(arm.metrics.averageCostUsd),
    delta: (arm) => arm.deltas?.averageCostUsd ?? null,
  },
  {
    label: "Search hits",
    note: "per trace",
    value: (arm) => formatAverage(arm.metrics.averageSearchHitCount),
    sub: (arm) => `${formatAverage(arm.metrics.averageSearchCount)} searches / trace`,
    delta: (arm) => arm.deltas?.averageSearchHitCount ?? null,
    lowerIsBetter: null,
  },
];

/**
 * Arms side by side as one matrix rather than one card per arm.
 *
 * Cards repeated every metric label per arm, so two arms cost seven duplicated
 * labels and a screen and a half of height, and the numbers a reader actually
 * wants to compare never lined up on a row. A leading metric column removes the
 * duplication, aligns the comparison, and drops the section to a fraction of its
 * former height — and the column count follows the number of arms, so a
 * two-arm experiment no longer leaves a hole where a third card would go.
 */
export function ArmComparisonGrid({
  arms,
  baselineArm,
  mode,
}: {
  arms: readonly ComparedArm[];
  baselineArm: string;
  mode: ExperimentMode;
}) {
  const visibleArms = selectVisibleArms(arms, baselineArm, MAX_VISIBLE_ARMS);
  const hiddenArmCount = arms.length - visibleArms.length;
  const columns = withRoles(visibleArms, baselineArm);

  return (
    <section aria-labelledby="arm-comparison-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="eyebrow">Outcome telemetry</div>
          <h2
            id="arm-comparison-title"
            className="mt-1 font-display text-lg font-semibold tracking-tight text-cream"
          >
            Arm comparison
          </h2>
        </div>
        <p className="max-w-xl text-pretty text-left text-xs leading-relaxed text-warm-muted sm:text-right">
          {MODE_NOTICE[mode]}
        </p>
      </div>

      <div className="card-enter mt-3 overflow-hidden rounded-2xl border border-forest-300 bg-forest-600/45">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse text-xs">
            <caption className="sr-only">
              Outcome metrics for each experiment arm, with each variant&apos;s change versus the{" "}
              {baselineArm} baseline
            </caption>
            <thead>
              <tr className="border-b border-forest-300 bg-base-deep/30 text-left">
                <th
                  scope="col"
                  className="w-40 px-4 py-2.5 font-mono text-[10px] font-normal uppercase tracking-[0.08em] text-warm-muted"
                >
                  Metric
                </th>
                {columns.map((column) => (
                  <ArmHeaderCell
                    key={column.arm.arm}
                    arm={column.arm.arm}
                    baseline={column.baseline}
                    role={column.role}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {METRIC_ROWS.map((row) => (
                <tr
                  key={row.label}
                  className="border-b border-forest-300/45 transition-colors last:border-0 hover:bg-forest/25"
                >
                  <th scope="row" className="px-4 py-2 text-left align-middle font-normal">
                    <span className="block text-xs text-cream-dim">{row.label}</span>
                    {row.note && (
                      <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-wide text-warm-muted">
                        {row.note}
                      </span>
                    )}
                  </th>
                  {columns.map((column) => (
                    <MetricCell
                      key={column.arm.arm}
                      row={row}
                      arm={column.arm}
                      baseline={column.baseline}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* The baseline/variant rule is legible from the column headers; a
            paragraph restating it was wall-of-text nobody reads. Only the
            genuinely surprising case — arms silently missing — still speaks. */}
        {hiddenArmCount > 0 && (
          <p className="border-t border-forest-300/60 bg-base-deep/25 px-4 py-2 text-[11px] text-coral">
            {hiddenArmCount} further arm
            {hiddenArmCount === 1 ? " is" : "s are"} hidden; the baseline and the first{" "}
            {MAX_VISIBLE_ARMS - 1} variants are shown.
          </p>
        )}
      </div>
    </section>
  );
}

interface ArmColumn {
  arm: ComparedArm;
  baseline: boolean;
  role: string;
}

/** Pair each visible arm with its derived role label (see {@link armRoleLabel}). */
function withRoles(visibleArms: readonly ComparedArm[], baselineArm: string): ArmColumn[] {
  const variantCount = visibleArms.filter(({ arm }) => arm !== baselineArm).length;
  let variantIndex = 0;
  return visibleArms.map((arm) => {
    const baseline = arm.arm === baselineArm;
    return {
      arm,
      baseline,
      role: armRoleLabel(baseline ? -1 : variantIndex++, variantCount),
    };
  });
}

function ArmHeaderCell({ arm, baseline, role }: { arm: string; baseline: boolean; role: string }) {
  return (
    <th scope="col" className="min-w-36 px-4 py-2.5 text-right align-bottom font-normal">
      <span className="flex items-center justify-end gap-2">
        <span
          className={cn("size-1.5 shrink-0 rounded-full", baseline ? "bg-coral" : "bg-ctx-memory")}
          aria-hidden
        />
        <span className="min-w-0 truncate font-mono text-xs font-medium text-cream" title={arm}>
          {arm}
        </span>
      </span>
      <span
        className={cn(
          "mt-1 block font-mono text-[9px] uppercase tracking-[0.08em]",
          baseline ? "text-coral" : "text-warm-muted",
        )}
      >
        {role}
      </span>
    </th>
  );
}

function MetricCell({
  row,
  arm,
  baseline,
}: {
  row: MetricRow;
  arm: ComparedArm;
  baseline: boolean;
}) {
  const delta = row.delta?.(arm) ?? null;
  const sub = row.sub?.(arm);

  return (
    <td className="px-4 py-2 text-right align-middle">
      <span className="flex items-center justify-end gap-2">
        <span className="font-mono text-sm font-medium tabular-nums text-cream">
          {row.value(arm)}
        </span>
        {row.delta && !baseline && (
          <DeltaChip delta={delta} display={row.display} lowerIsBetter={row.lowerIsBetter} />
        )}
      </span>
      {sub && <span className="mt-0.5 block font-mono text-[10px] text-warm-muted">{sub}</span>}
    </td>
  );
}

function totalTokens(arm: ComparedArm): number {
  return arm.metrics.averageInputTokens + arm.metrics.averageOutputTokens;
}

function formatPercent(value: number): string {
  return `${(value * 100).toLocaleString("en-US", {
    maximumFractionDigits: 1,
  })}%`;
}

function formatAverage(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function sumDelta(
  left: MetricDelta | null,
  right: MetricDelta | null,
  value: number,
): MetricDelta | null {
  if (!left || !right) return null;
  const absolute = left.absolute + right.absolute;
  const baseline = value - absolute;
  return {
    absolute,
    relative: baseline === 0 ? null : absolute / baseline,
  };
}
