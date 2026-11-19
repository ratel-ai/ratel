import { Sparkline } from "@/components/console/health/primitives/Sparkline";
import { storyDay } from "@/components/console/health/TurnStory";
import { qualityTokens } from "@/components/console/quality/report/theme";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import type { EvidenceChart as EvidenceChartModel } from "@/lib/readings/trace-signals/view";

/**
 * The small chart in an open signal card: a rank histogram in the match-quality
 * rank ramp (brightest is first place, grey is "not in the list"), or a daily
 * sparkline. Static SVG and CSS only; every number it shows is printed, so it
 * reads the same with no hover.
 */
export function EvidenceChart({ chart }: { chart: EvidenceChartModel }) {
  return chart.kind === "rank_histogram" ? (
    <RankHistogram bands={chart.bands} />
  ) : (
    <DailyLine points={chart.points} />
  );
}

/** Band position to the rank ramp; a "not listed" band is always the grey. */
function bandColor(label: string, index: number): string {
  if (/not/i.test(label)) return "var(--q-rank-none)";
  if (index === 0) return "var(--q-rank-1)";
  if (index === 1) return "var(--q-rank-2)";
  return "var(--q-rank-3)";
}

function RankHistogram({ bands }: { bands: readonly { label: string; count: number }[] }) {
  const max = Math.max(1, ...bands.map((band) => band.count));
  const summary = bands.map((band) => `${band.label}: ${formatCount(band.count)}`).join(", ");
  return (
    <figure
      data-evidence-chart="rank_histogram"
      className="q-scope"
      style={qualityTokens("screen")}
    >
      <figcaption className="text-[13px] text-warm-muted">By position in the list</figcaption>
      <div
        role="img"
        aria-label={`By position in the list. ${summary}`}
        className="mt-3 flex items-end gap-2"
      >
        {bands.map((band, index) => (
          <div
            key={band.label}
            className="flex min-w-0 max-w-16 flex-1 flex-col items-center gap-1.5"
          >
            <span className="font-mono text-[10px] tabular-nums text-cream-dim">
              {formatCount(band.count)}
            </span>
            <div className="flex h-14 w-full items-end">
              <div
                className="w-full rounded-t-[3px]"
                style={{
                  height: `${Math.max(4, (band.count / max) * 100)}%`,
                  backgroundColor: bandColor(band.label, index),
                }}
              />
            </div>
            <span className="w-full truncate text-center font-mono text-[10px] text-warm-muted">
              {band.label}
            </span>
          </div>
        ))}
      </div>
    </figure>
  );
}

function DailyLine({ points }: { points: readonly { day: string; value: number | null }[] }) {
  const values = points.flatMap((point) => (point.value === null ? [] : [point.value]));
  const first = points[0]?.day;
  const last = points.at(-1)?.day;
  return (
    <figure data-evidence-chart="sparkline">
      <figcaption className="text-[13px] text-warm-muted">Day by day</figcaption>
      <div className="mt-3 w-full max-w-60">
        <Sparkline data={values} color="var(--color-ctx-tools)" width={240} height={40} />
        {first && last && (
          <div className="mt-1 flex justify-between font-mono text-[10px] uppercase tracking-[0.08em] text-warm-muted">
            <span>{storyDay(`${first}T00:00:00.000Z`)}</span>
            <span>{storyDay(`${last}T00:00:00.000Z`)}</span>
          </div>
        )}
      </div>
    </figure>
  );
}
