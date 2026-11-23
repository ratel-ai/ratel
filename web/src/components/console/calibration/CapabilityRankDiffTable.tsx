import { cn } from "@ratel/design-system/cn";
import type {
  CapabilityArmComparison,
  CapabilityComparison,
  CapabilityComparisonSet,
} from "@/lib/synthesis/experiments/types";
import {
  armRoleLabel,
  displayCapabilityRank,
  selectVisibleArms,
  sortCapabilitiesByVisibleDelta,
} from "@/lib/synthesis/traces/experiment-view";

const MAX_VISIBLE_ARMS = 3;

/** Grid template for N arm tiles — never leaves an empty slot behind. */
const TILE_COLUMNS: Record<number, string> = {
  1: "sm:grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
};

export function CapabilityRankDiffTable({
  comparison,
  baselineArm,
  arms,
}: {
  comparison: CapabilityComparisonSet;
  baselineArm: string;
  arms: readonly string[];
}) {
  const visibleArms = selectVisibleArms(
    arms.map((arm) => ({ arm })),
    baselineArm,
    MAX_VISIBLE_ARMS,
  ).map(({ arm }) => arm);

  return (
    <section aria-labelledby="capability-diff-title">
      <div>
        <div className="eyebrow">Retrieval behavior</div>
        <h2
          id="capability-diff-title"
          className="mt-1 font-display text-lg font-semibold tracking-tight text-cream"
        >
          Capability ranking diff
        </h2>
        <p className="mt-1 max-w-2xl text-pretty text-xs leading-relaxed text-warm-muted">
          Average search-result position by capability. Lower ranks appear earlier; rows with the
          largest absolute movement lead.
        </p>
      </div>

      {comparison.hasRankings ? (
        <RankingTable rows={comparison.rows} visibleArms={visibleArms} baselineArm={baselineArm} />
      ) : (
        <ReportedHitFallback
          comparison={comparison}
          visibleArms={visibleArms}
          baselineArm={baselineArm}
        />
      )}
    </section>
  );
}

function RankingTable({
  rows,
  visibleArms,
  baselineArm,
}: {
  rows: readonly CapabilityComparison[];
  visibleArms: readonly string[];
  baselineArm: string;
}) {
  if (rows.length === 0) {
    return (
      <EmptyPanel>No capability hits were retained for the selected experiment window.</EmptyPanel>
    );
  }

  const sortedRows = sortCapabilitiesByVisibleDelta(rows, visibleArms, baselineArm);

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-forest-300 bg-forest-600/35">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-xs">
          <caption className="sr-only">
            Capability average ranking and rank delta by experiment arm
          </caption>
          <thead>
            <tr className="border-b border-forest-300 bg-base-deep/25 text-left font-mono text-[10px] uppercase tracking-[0.07em] text-warm-muted">
              <th className="px-4 py-2.5 font-normal">Capability</th>
              {visibleArms.map((arm, index) => (
                <th key={arm} className="min-w-40 px-4 py-2.5 text-right font-normal">
                  {arm}
                  <span
                    className={cn(
                      "ml-1.5",
                      arm === baselineArm ? "text-coral" : "text-warm-muted/60",
                    )}
                  >
                    · {roleFor(arm, baselineArm, visibleArms, index)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => (
              <tr
                key={`${row.type}:${row.id}`}
                className="border-b border-forest-300/45 last:border-0"
              >
                <th scope="row" className="px-4 py-3 text-left font-normal">
                  <span className="block font-medium text-cream">{row.id}</span>
                  <span className="mt-0.5 block font-mono text-[9px] uppercase tracking-wide text-warm-muted">
                    {row.type}
                  </span>
                </th>
                {visibleArms.map((arm) => (
                  <td key={arm} className="px-4 py-3 text-right">
                    <RankCell comparison={armComparison(row, arm)} baseline={arm === baselineArm} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RankCell({
  comparison,
  baseline,
}: {
  comparison: CapabilityArmComparison | null;
  baseline: boolean;
}) {
  if (!comparison || comparison.absent) {
    return (
      <span className="inline-flex rounded-md border border-coral/30 bg-coral/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-coral">
        absent
      </span>
    );
  }
  const delta = comparison.rankDelta;

  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="font-mono tabular-nums text-cream">
        #{formatRank(comparison.averageRank)}
      </span>
      {!baseline && delta !== null && (
        <span
          className={cn(
            "rounded-md border px-1.5 py-0.5 font-mono text-[10px] tabular-nums",
            delta > 0
              ? "border-coral/25 bg-coral/10 text-coral"
              : delta < 0
                ? "border-green/25 bg-green/10 text-green"
                : "border-forest-300 bg-forest/40 text-warm-muted",
          )}
          title="Average rank movement versus baseline"
        >
          {delta > 0 ? "↓" : delta < 0 ? "↑" : "→"}{" "}
          {delta === 0 ? "0" : formatSigned(Math.abs(delta))}
        </span>
      )}
      <span className="font-mono text-[10px] text-warm-muted">n={comparison.appearances}</span>
    </span>
  );
}

function ReportedHitFallback({
  comparison,
  visibleArms,
  baselineArm,
}: {
  comparison: CapabilityComparisonSet;
  visibleArms: readonly string[];
  baselineArm: string;
}) {
  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-dashed border-forest-300 bg-forest-600/20">
      <div className="border-b border-forest-300/70 px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-ctx-tools">
          No comparable rankings
        </div>
        <p className="mt-1 text-xs leading-relaxed text-warm-muted">
          No comparable ordered rankings are available for every arm. Available count telemetry is
          shown; rank and absence claims are withheld.
        </p>
      </div>
      <div
        className={cn(
          "grid gap-px bg-forest-300",
          TILE_COLUMNS[visibleArms.length] ?? "sm:grid-cols-3",
        )}
      >
        {visibleArms.map((arm, index) => {
          const metric = comparison.reportedHitMetrics.find((candidate) => candidate.arm === arm);
          const baseline = arm === baselineArm;
          return (
            <div key={arm} className="bg-canvas px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    baseline ? "bg-coral" : "bg-ctx-memory",
                  )}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-cream" title={arm}>
                  {arm}
                </span>
                <span
                  className={cn(
                    "shrink-0 font-mono text-[9px] uppercase tracking-[0.08em]",
                    baseline ? "text-coral" : "text-warm-muted",
                  )}
                >
                  {roleFor(arm, baselineArm, visibleArms, index)}
                </span>
              </div>
              <div className="mt-2 font-display text-xl font-semibold tabular-nums text-cream">
                {metric?.averagePerSearch == null
                  ? "—"
                  : metric.averagePerSearch.toLocaleString("en-US", {
                      maximumFractionDigits: 1,
                    })}
              </div>
              <div className="mt-0.5 text-[10px] text-warm-muted">
                hits / search · {metric?.searchSpanCount ?? 0} search spans
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EmptyPanel({ children }: { children: string }) {
  return (
    <p className="mt-3 rounded-2xl border border-dashed border-forest-300 bg-forest-600/20 px-5 py-8 text-center text-sm text-warm-muted">
      {children}
    </p>
  );
}

/** Baseline / variant label for one arm column, matching the arm-comparison matrix. */
function roleFor(
  arm: string,
  baselineArm: string,
  visibleArms: readonly string[],
  index: number,
): string {
  if (arm === baselineArm) return armRoleLabel(-1, 0);
  const variantCount = visibleArms.filter((candidate) => candidate !== baselineArm).length;
  const variantIndex = visibleArms
    .slice(0, index)
    .filter((candidate) => candidate !== baselineArm).length;
  return armRoleLabel(variantIndex, variantCount);
}

function armComparison(row: CapabilityComparison, arm: string): CapabilityArmComparison | null {
  return row.arms.find((item) => item.arm === arm) ?? null;
}

function formatRank(value: number | null): string {
  const displayRank = displayCapabilityRank(value);
  return displayRank === null
    ? "—"
    : displayRank.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function formatSigned(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
}
