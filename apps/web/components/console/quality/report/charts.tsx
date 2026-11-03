import { armColor, RANK_BANDS } from "@/components/console/quality/report/theme";
import { ABSENT, type RankHistogram } from "@/lib/synthesis/quality/metrics";

/**
 * Dependency-free SVG charts for the quality surfaces.
 *
 * Server-renderable and static: no hooks, no measurement, no client bundle. That
 * is not only the house convention here, it is what lets the identical component
 * render into a printed page, where there is no hover to fall back on and every
 * value a reader needs has to already be on the page.
 */

/**
 * A proportion per arm, on one shared axis, with its uncertainty on the mark.
 *
 * One chart rather than a stack of separate bars: the reader's real question is
 * "which arm is higher, and by how much", and a shared baseline answers that
 * instantly where two independent bars do not.
 *
 * Uncertainty rides as a conventional error bar, a hairline with end caps drawn
 * through the bar, rather than as a second fill. A paler shade of the same hue
 * reads as a second category and leaves the reader guessing which part is the
 * answer; a capped line is a different visual language, so it cannot be mistaken
 * for the value it qualifies.
 */
export interface RateRow {
  label: string;
  value: number | null;
  interval?: { low: number; high: number } | null;
  color: string;
  /** Secondary text under the label, such as the sample size. */
  meta?: string;
}

export function RateComparison({
  rows,
  width = 720,
}: {
  rows: readonly RateRow[];
  width?: number;
}) {
  const labelW = 108;
  const valueW = 52;
  const rowH = 42;
  const barH = 16;
  const padTop = 22;
  const plotX = labelW;
  const plotW = width - labelW - valueW;
  const height = padTop + rows.length * rowH + 6;
  const x = (value: number) => plotX + Math.max(0, Math.min(1, value)) * plotW;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="q-chart"
      role="img"
      aria-label="Share of searches, by arm"
    >
      {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
        <g key={tick}>
          <line
            x1={x(tick)}
            y1={padTop - 6}
            x2={x(tick)}
            y2={height - 6}
            stroke="var(--q-line)"
            strokeWidth="1"
          />
          <text
            x={x(tick)}
            y={padTop - 11}
            textAnchor={tick === 0 ? "start" : tick === 1 ? "end" : "middle"}
            fontSize="10"
            fill="var(--q-muted)"
          >
            {tick * 100}%
          </text>
        </g>
      ))}

      {rows.map((row, index) => {
        const cy = padTop + index * rowH + rowH / 2;
        const value = row.value;
        return (
          <g key={row.label}>
            <text
              x={0}
              y={row.meta ? cy - 2 : cy + 4}
              fontSize="12.5"
              fill="var(--q-ink)"
              fontWeight="500"
            >
              {row.label}
            </text>
            {row.meta && (
              <text x={0} y={cy + 12} fontSize="10" fill="var(--q-muted)">
                {row.meta}
              </text>
            )}

            {value === null ? (
              <text x={plotX} y={cy + 4} fontSize="11" fill="var(--q-muted)">
                no evidence yet
              </text>
            ) : (
              <>
                <path
                  d={roundedRightBar(plotX, cy - barH / 2, x(value) - plotX, barH, 4)}
                  fill={row.color}
                />
                {row.interval && (
                  <g stroke="var(--q-ink)" strokeWidth="1.5" strokeLinecap="round">
                    <line x1={x(row.interval.low)} y1={cy} x2={x(row.interval.high)} y2={cy} />
                    <line
                      x1={x(row.interval.low)}
                      y1={cy - 5}
                      x2={x(row.interval.low)}
                      y2={cy + 5}
                    />
                    <line
                      x1={x(row.interval.high)}
                      y1={cy - 5}
                      x2={x(row.interval.high)}
                      y2={cy + 5}
                    />
                  </g>
                )}
                <text
                  x={width - valueW + 10}
                  y={cy + 5}
                  fontSize="13.5"
                  fontWeight="600"
                  fill="var(--q-ink)"
                >
                  {Math.round(value * 100)}%
                </text>
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** A bar squared off at the baseline and rounded at the data end. */
function roundedRightBar(x: number, y: number, w: number, h: number, r: number): string {
  if (w <= 0) return "";
  const radius = Math.max(0, Math.min(r, w));
  return [
    `M${x},${y}`,
    `H${x + w - radius}`,
    `Q${x + w},${y} ${x + w},${y + radius}`,
    `V${y + h - radius}`,
    `Q${x + w},${y + h} ${x + w - radius},${y + h}`,
    `H${x}`,
    "Z",
  ].join(" ");
}

/**
 * How high each arm ranked the tool, as a part-to-whole across the positions.
 *
 * A rank distribution is an ordered-scale share, so it is a stacked bar on a
 * sequential ramp. The column grid this replaces spent most of its ink on empty
 * slots for ranks nobody hit, asked the reader to decode bare "1, 2, 3" axis
 * numbers, and made the two arms impossible to compare without counting. One
 * full-width bar per arm compares by length at a glance, carries no empty ink,
 * and names its own bands in the legend.
 */
export function RankMixChart({
  rows,
  width = 720,
}: {
  rows: readonly { label: string; histogram: RankHistogram; total: number }[];
  width?: number;
}) {
  const labelW = 108;
  const rowH = 48;
  const barH = 22;
  const gap = 2;
  const plotX = labelW;
  const plotW = width - labelW;
  const height = rows.length * rowH;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="q-chart"
      role="img"
      aria-label="Where in the list the tool was found, by arm"
    >
      {rows.map((row, index) => {
        const bands = rankBands(row.histogram, row.total);
        const top = index * rowH + (rowH - barH) / 2;
        let cursor = plotX;
        return (
          <g key={row.label}>
            <text x={0} y={top + barH / 2 - 1} fontSize="12.5" fill="var(--q-ink)" fontWeight="500">
              {row.label}
            </text>
            <text x={0} y={top + barH / 2 + 13} fontSize="10" fill="var(--q-muted)">
              {row.total} searches
            </text>
            {bands.map((band, bandIndex) => {
              const raw = band.share * plotW;
              // The 2px surface gap is the separator, so it is taken out of the
              // fill rather than drawn as a stroke on top of it.
              const trailing = bandIndex < bands.length - 1 ? gap : 0;
              const w = Math.max(0, raw - trailing);
              const x = cursor;
              cursor += raw;
              if (w <= 0) return null;
              return (
                <g key={band.key}>
                  <path
                    d={stackSegment(
                      x,
                      top,
                      w,
                      barH,
                      bandIndex === 0,
                      bandIndex === bands.length - 1,
                      4,
                    )}
                    fill={band.color}
                  />
                  {/* Only label a segment wide enough to hold the text with
                      padding on both sides; the legend carries the rest. */}
                  {w >= 40 && (
                    <text
                      x={x + w / 2}
                      y={top + barH / 2 + 4}
                      textAnchor="middle"
                      fontSize="11"
                      fontWeight="600"
                      fill={band.onFill}
                    >
                      {Math.round(band.share * 100)}%
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

/** Rounded only where a segment meets the end of the whole bar. */
function stackSegment(
  x: number,
  y: number,
  w: number,
  h: number,
  first: boolean,
  last: boolean,
  r: number,
): string {
  const radius = Math.max(0, Math.min(r, w / 2));
  const left = first ? radius : 0;
  const right = last ? radius : 0;
  return [
    `M${x + left},${y}`,
    `H${x + w - right}`,
    right ? `Q${x + w},${y} ${x + w},${y + right}` : "",
    `V${y + h - right}`,
    right ? `Q${x + w},${y + h} ${x + w - right},${y + h}` : "",
    `H${x + left}`,
    left ? `Q${x},${y + h} ${x},${y + h - left}` : "",
    `V${y + left}`,
    left ? `Q${x},${y} ${x + left},${y}` : "",
    "Z",
  ]
    .filter(Boolean)
    .join(" ");
}

export interface RankBand {
  key: string;
  label: string;
  color: string;
  onFill: string;
  share: number;
}

/**
 * Fold a rank histogram into the bands the chart draws.
 *
 * `1` is first place alone, `23` is second or third, `4` is everything below
 * that, and `none` is the searches where the arm never returned the tool. Empty
 * bands are dropped rather than drawn at zero width, so a bar carries no ink for
 * an outcome that did not happen.
 */
export function rankBands(histogram: RankHistogram, total: number): RankBand[] {
  if (total <= 0) return [];
  let first = 0;
  let near = 0;
  let buried = 0;
  for (const [key, count] of Object.entries(histogram)) {
    if (key === ABSENT) continue;
    const rank = Number(key);
    if (!Number.isFinite(rank) || rank < 1) continue;
    if (rank === 1) first += count;
    else if (rank <= 3) near += count;
    else buried += count;
  }
  const counts: Record<string, number> = {
    "1": first,
    "23": near,
    "4": buried,
    none: histogram[ABSENT] ?? 0,
  };

  return RANK_BANDS.flatMap((band) => {
    const count = counts[band.key] ?? 0;
    if (count <= 0) return [];
    return [
      {
        key: band.key,
        label: band.label,
        color: band.color,
        // Ink on the two palest bands, surface on the rest, so an in-segment
        // label always clears its own fill on either surface.
        onFill:
          band.key === "4" || band.key === "none"
            ? "var(--q-on-fill-light)"
            : "var(--q-on-fill-dark)",
        share: count / total,
      },
    ];
  });
}

/**
 * The key for {@link RankMixChart}, always shown.
 *
 * Five bands is past the point where colour alone can carry identity, so the
 * legend is not optional here even though the ramp is ordered.
 */
export function RankLegend() {
  return (
    <div className="q-legend">
      {RANK_BANDS.map((band) => (
        <span key={band.key}>
          <Swatch color={band.color} />
          {band.label}
        </span>
      ))}
    </div>
  );
}

/**
 * A legend chip drawn as SVG rather than a CSS background.
 *
 * Chrome prints with "Background graphics" off by default, which drops every
 * CSS `background` on the page. A legend whose chips are backgrounds prints as a
 * row of unlabelled words, which is worse than no legend at all. An SVG `fill`
 * is content, so it survives either setting.
 */
export function Swatch({ color }: { color: string }) {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden className="q-swatch-svg">
      <rect width="11" height="11" rx="3" fill={color} />
    </svg>
  );
}

/**
 * Two latencies drawn to the same scale.
 *
 * Deliberately linear, not logarithmic. The whole message is that one bar is
 * thirty times the other, and a log axis is exactly the transformation that
 * would hide it. The fast bar is given a floor of half a percent so it stays
 * visible as a mark rather than vanishing into the axis.
 */
export function LatencyBars({
  rows,
}: {
  rows: { arm: string; ms: number | null; color: string }[];
}) {
  const max = Math.max(1, ...rows.map((row) => row.ms ?? 0));
  return (
    <div className="q-latency">
      {rows.map((row) => (
        <div key={row.arm} className="q-latency-row">
          <span className="q-latency-arm">{row.arm}</span>
          <svg
            viewBox="0 0 100 10"
            preserveAspectRatio="none"
            className="q-latency-bar"
            role="img"
            aria-label={`${row.arm}: ${formatMs(row.ms)}`}
          >
            <rect x="0" y="2" width="100" height="6" rx="3" fill="var(--q-track)" />
            <rect
              x="0"
              y="2"
              width={row.ms === null ? 0 : Math.max(0.5, (row.ms / max) * 100)}
              height="6"
              rx="3"
              fill={row.color}
            />
          </svg>
          <span className="q-latency-value">{formatMs(row.ms)}</span>
        </div>
      ))}
    </div>
  );
}

export function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/**
 * The quality trend, one line per arm, with corpus changes marked.
 *
 * The vertical rules are the reason the chart exists: a quality number on its
 * own says how we are doing, and a quality number next to the day the searchable
 * descriptions changed says whether the edit worked. Days with no traffic break
 * the line rather than interpolating across them, because a straight segment
 * over a silent weekend reads as measured and is not.
 */
export interface TrendPoint {
  day: Date;
  value: number | null;
  n: number;
}

export function TrendChart({
  series,
  markers = [],
  height = 150,
  width = 720,
}: {
  series: { arm: string; color: string; points: TrendPoint[] }[];
  markers?: { at: Date; label: string }[];
  height?: number;
  width?: number;
}) {
  const days = [
    ...new Set(series.flatMap((entry) => entry.points.map((point) => point.day.getTime()))),
  ].sort((left, right) => left - right);
  if (days.length === 0) return null;

  const padTop = 12;
  const padBottom = 22;
  const padLeft = 34;
  const plotW = width - padLeft - 8;
  const plotH = height - padTop - padBottom;
  const x = (time: number) =>
    padLeft + (days.length === 1 ? plotW / 2 : (days.indexOf(time) / (days.length - 1)) * plotW);
  const y = (value: number) => padTop + plotH - value * plotH;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="q-trend"
      role="img"
      aria-label="Quality over time"
    >
      {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
        <g key={tick}>
          <line
            x1={padLeft}
            y1={y(tick)}
            x2={width - 8}
            y2={y(tick)}
            stroke="var(--q-line)"
            strokeWidth="1"
          />
          <text x={padLeft - 6} y={y(tick) + 3} textAnchor="end" fontSize="9" fill="var(--q-muted)">
            {tick * 100}%
          </text>
        </g>
      ))}

      {markers.map((marker) => {
        const day = startOfDay(marker.at).getTime();
        if (!days.includes(day)) return null;
        // A change on the last day would run its label off the right edge, so
        // labels flip to the inside of the rule when they are close to it.
        const at = x(day);
        const flip = at > width - 60;
        return (
          <g key={`${marker.label}-${day}`}>
            <line
              x1={at}
              y1={padTop}
              x2={at}
              y2={padTop + plotH}
              stroke="var(--q-muted)"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            <text
              x={flip ? at - 4 : at + 4}
              y={padTop + 8}
              textAnchor={flip ? "end" : "start"}
              fontSize="8"
              fill="var(--q-muted)"
            >
              {marker.label}
            </text>
          </g>
        );
      })}

      {series.map((entry) => {
        const segments = splitSegments(entry.points);
        return (
          <g key={entry.arm}>
            {segments.map((segment, index) => (
              <polyline
                key={index}
                fill="none"
                stroke={entry.color}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                points={segment
                  .map((point) => `${x(point.day.getTime())},${y(point.value!)}`)
                  .join(" ")}
              />
            ))}
            {entry.points
              .filter((point) => point.value !== null)
              .map((point) => (
                <circle
                  key={point.day.getTime()}
                  cx={x(point.day.getTime())}
                  cy={y(point.value!)}
                  r="2.5"
                  fill={entry.color}
                />
              ))}
            {/* A day that had traffic but too little of it to plot gets a tick
                on the axis. Without it, "two searches, below the floor" looks
                exactly like "the system was down", and readers reasonably
                report the gap as missing data. */}
            {entry.points
              .filter((point) => point.value === null && point.n > 0)
              .map((point) => (
                <rect
                  key={`sparse-${point.day.getTime()}`}
                  x={x(point.day.getTime()) - 3}
                  y={padTop + plotH + 2}
                  width="6"
                  height="2"
                  rx="1"
                  fill={entry.color}
                  opacity="0.45"
                />
              ))}
          </g>
        );
      })}

      {days.map((day, index) => {
        const step = Math.max(1, Math.ceil(days.length / 7));
        if ((days.length - 1 - index) % step !== 0) return null;
        // The axis always keeps its most recent tick, which sits on the right
        // edge, so the first and last labels anchor inward instead of centring
        // and hanging off the plot.
        const at = x(day);
        const anchor = at > width - 30 ? "end" : at < padLeft + 20 ? "start" : "middle";
        return (
          <text
            key={day}
            x={at}
            y={height - 6}
            textAnchor={anchor}
            fontSize="9"
            fill="var(--q-muted)"
          >
            {new Date(day).toLocaleDateString("en-IE", {
              month: "short",
              day: "numeric",
              timeZone: "UTC",
            })}
          </text>
        );
      })}
    </svg>
  );
}

/** Split a series at its gaps, so a silent day breaks the line. */
function splitSegments(points: readonly TrendPoint[]): TrendPoint[][] {
  const segments: TrendPoint[][] = [];
  let current: TrendPoint[] = [];
  for (const point of points) {
    if (point.value === null) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push(point);
  }
  if (current.length > 0) segments.push(current);
  // A lone point has no line to draw, but still deserves its dot, which the
  // caller renders separately, so single-point segments are kept, not dropped.
  return segments;
}

function startOfDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

export { armColor };
