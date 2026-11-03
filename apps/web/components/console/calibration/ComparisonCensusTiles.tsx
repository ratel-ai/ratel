import type { ExperimentCalibrationSummary } from "@/lib/synthesis/experiments/calibration-types";
import { formatScore } from "@/lib/synthesis/traces/calibration-view";

/**
 * Census tiles for one ranking-shadow row on the calibration index.
 *
 * Replaces the per-arm trace tiles for these experiments on purpose. Arm trace
 * counts come from sampled spans and count every trace that merely *contains*
 * an arm — single-arm rollout traffic, repeated benchmark runs, and local
 * development included — so they read as a traffic split the experiment never
 * ran. Comparison records are the paired census instead: exactly one per
 * shadow-tested request, and unsampled, because they ride the OTel Logs signal.
 */
export function ComparisonCensusTiles({ census }: { census: ExperimentCalibrationSummary }) {
  return (
    <div className="flex min-w-0 flex-wrap gap-2">
      <CensusTile label="comparisons" value={census.comparisonCount} share={null} />
      <CensusTile
        label="mismatches"
        value={census.mismatchCount}
        share={census.comparisonCount === 0 ? null : census.mismatchCount / census.comparisonCount}
      />
    </div>
  );
}

function CensusTile({
  label,
  value,
  share,
}: {
  label: string;
  value: number;
  share: number | null;
}) {
  return (
    <div className="min-w-28 rounded-lg border border-forest-300 bg-base-deep/35 px-2.5 py-2">
      <div className="truncate font-mono text-[10px] text-cream-dim">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="font-display text-lg font-semibold text-cream">
          {value.toLocaleString("en-US")}
        </span>
        {share !== null && (
          <span className="font-mono text-[9px] text-warm-muted">{formatScore(share)}</span>
        )}
      </div>
    </div>
  );
}
