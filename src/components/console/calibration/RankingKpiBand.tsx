import type { ArmPairAgreementSummary } from "@/lib/synthesis/experiments/calibration-types";
import { formatScore } from "@/lib/synthesis/traces/calibration-view";

interface KpiTileSpec {
  key: string;
  label: string;
  accent: string;
  value: string;
  sub: string;
}

/**
 * Census vitals for one served→shadow comparison pair. Every number here comes
 * from `ratel.experiment.comparison` log records, so it covers all shadow-tested
 * requests even when arm spans are trace-sampled.
 */
export function RankingKpiBand({
  pair,
  shadowCoverage,
  showPairLabel = false,
}: {
  pair: ArmPairAgreementSummary;
  shadowCoverage: number | null;
  /** Identify the pair visibly when several directions render on one page. */
  showPairLabel?: boolean;
}) {
  const tiles: KpiTileSpec[] = [
    {
      key: "comparisons",
      label: "Comparisons",
      accent: "var(--color-indigo-300)",
      value: pair.comparisonCount.toLocaleString("en-US"),
      sub: `${pair.mismatchCount.toLocaleString("en-US")} mismatch${
        pair.mismatchCount === 1 ? "" : "es"
      } flagged`,
    },
    {
      key: "match-score",
      label: "Match score",
      accent: "var(--color-green)",
      value: formatScore(pair.averageJaccardAtK),
      sub: matchScoreSub(pair),
    },
    {
      key: "top1",
      label: "Top-1 agreement",
      accent: "var(--color-ctx-tools)",
      value: formatScore(pair.top1Rate),
      sub: "same first result on both arms",
    },
    {
      key: "exact-order",
      label: "Exact order",
      accent: "var(--color-ctx-memory)",
      value: formatScore(pair.exactOrderRate),
      sub: "identical ranked lists",
    },
    {
      key: "coverage",
      label: "Shadow coverage",
      accent: "var(--color-coral)",
      value: formatScore(shadowCoverage),
      sub: "comparisons over eligible shadows",
    },
  ];

  return (
    <section
      aria-label={`Ranking agreement for ${pair.servedArm} versus ${pair.shadowArm}`}
      className="flex flex-col gap-2"
    >
      {showPairLabel && (
        <div className="font-mono text-[10px] uppercase tracking-wide text-warm-muted">
          serving <span className="text-cream-dim">{pair.servedArm}</span>
          {" · shadowing "}
          <span className="text-cream-dim">{pair.shadowArm}</span>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {tiles.map((tile, index) => (
          <KpiTile key={tile.key} tile={tile} index={index} />
        ))}
      </div>
    </section>
  );
}

function matchScoreSub(pair: ArmPairAgreementSummary): string {
  if (pair.jaccardByK.length === 0) return "mean Jaccard@k";
  if (pair.jaccardByK.length === 1) {
    return `mean Jaccard at k=${pair.jaccardByK[0].k}`;
  }
  return pair.jaccardByK.map(({ k, mean }) => `k=${k} ${formatScore(mean)}`).join(" · ");
}

function KpiTile({ tile, index }: { tile: KpiTileSpec; index: number }) {
  return (
    <article
      className="card-enter relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-forest-300 bg-forest-600/60 p-4"
      style={{ animationDelay: `${120 + index * 90}ms` }}
    >
      <span
        className="pointer-events-none absolute inset-x-0 top-0 h-px opacity-70"
        style={{
          background: `linear-gradient(90deg, transparent 2%, ${tile.accent} 36%, transparent 82%)`,
        }}
        aria-hidden
      />
      <h3 className="flex min-w-0 items-center gap-1.5">
        <span
          className="inline-block size-1.5 shrink-0 rounded-full shadow-[0_0_8px_currentColor]"
          style={{ backgroundColor: tile.accent, color: tile.accent }}
          aria-hidden
        />
        <span className="eyebrow truncate">{tile.label}</span>
      </h3>
      <div className="mt-2 truncate font-display text-[1.75rem] font-semibold leading-none tracking-tight tabular-nums text-cream">
        {tile.value}
      </div>
      <div className="mt-1 truncate text-xs text-warm-muted" title={tile.sub}>
        {tile.sub}
      </div>
    </article>
  );
}
