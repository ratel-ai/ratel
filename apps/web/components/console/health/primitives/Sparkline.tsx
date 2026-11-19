import { cn } from "@ratel/design-system/cn";
import type { ReactNode } from "react";
import { areaPath, gapSegments, smoothPath, toPoints } from "@/lib/platform/chart";
import { type Delta, fmtDelta } from "@/lib/synthesis/dashboard";

/**
 * Tiny inline trend line — a smooth monotone curve over a faint fill, so the
 * table's per-source trends read like miniatures of the main charts. Pure SVG,
 * no hooks, no client JS (a solid low-opacity fill avoids needing a gradient id).
 */
export function Sparkline({
  data,
  color,
  width = 104,
  height = 28,
}: {
  data: number[];
  color: string;
  width?: number;
  height?: number;
}) {
  if (data.length === 0) {
    return <svg width={width} height={height} aria-hidden />;
  }
  const pad = 2;
  const max = Math.max(...data, 1);
  const pts = toPoints(data, {
    width: width - pad * 2,
    height: height - pad,
    padTop: pad,
    max,
  }).map(([x, y]) => [x + pad, y] as [number, number]);

  return (
    <svg width={width} height={height} aria-hidden className="overflow-visible">
      <path d={areaPath(pts, height)} fill={color} fillOpacity={0.1} stroke="none" />
      <path
        d={smoothPath(pts)}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* - Tile pieces shared by the dashboard vitals and the Agent health band ------ */

/**
 * A signed delta as a small tinted chip. Color encodes *outcome*, not raw
 * direction: the caller says whether the move is good (green) or bad (coral), and
 * the arrow carries the direction, so color is never the only signal. Extra
 * children (such as screen-reader text) ride after the label.
 */
export function TrendChip({
  up,
  good,
  label,
  title,
  size = "sm",
  children,
}: {
  up: boolean;
  good: boolean;
  label: string;
  title?: string;
  /** "sm" is the vitals chip; "md" reads at a glance next to a hero figure. */
  size?: "sm" | "md";
  children?: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md font-mono font-medium tabular-nums",
        size === "md"
          ? "gap-1 px-2 py-1 text-xs leading-none"
          : "gap-0.5 px-1.5 py-0.5 text-[11px]",
        good ? "bg-green/12 text-green" : "bg-coral/12 text-coral",
      )}
      title={title}
    >
      <Arrow up={up} />
      {label}
      {children}
    </span>
  );
}

/**
 * The dashboard vitals' delta chip. For cost-like vitals a rise is coral (worse)
 * and a fall green (better); for runs the sense flips (more calls is good). A flat
 * or absent delta stays muted so a quiet period never lights up as a warning.
 */
export function DeltaChip({ delta, upIsGood }: { delta: Delta | null; upIsGood: boolean }) {
  if (!delta || delta.dir === "flat") {
    return (
      <span className="font-mono text-[11px] text-warm-muted/70" aria-hidden>
        {delta ? "→ 0%" : ""}
      </span>
    );
  }
  const rising = delta.dir === "up";
  return (
    <TrendChip
      up={rising}
      good={rising === upIsGood}
      label={fmtDelta(delta.pct)}
      title={`${fmtDelta(delta.pct)} vs. earlier in the range`}
    />
  );
}

function Arrow({ up }: { up: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 9 9"
      fill="none"
      aria-hidden
      className={up ? "" : "rotate-180"}
    >
      <path
        d="M4.5 1.5v6M2 4l2.5-2.5L7 4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const TREND_W = 240;
const TREND_H = 44;

type Point = [number, number];

/** How a trend is inked: the vitals' quiet line, or the health band's stronger one. */
interface TrendInk {
  strokeWidth: number;
  strokeOpacity: number;
  fillOpacity: number;
  /** Diameter of the latest-day dot, in screen pixels. */
  dot: number;
  /** Diameter of a lone measured day between gaps. */
  lone: number;
  /** A soft ring around the latest-day dot; 0 draws none. */
  halo: number;
}

const INK_REGULAR: TrendInk = {
  strokeWidth: 1.5,
  strokeOpacity: 0.7,
  fillOpacity: 0.1,
  dot: 4,
  lone: 4,
  halo: 0,
};
const INK_STRONG: TrendInk = {
  strokeWidth: 2,
  strokeOpacity: 1,
  fillOpacity: 0.16,
  dot: 6,
  lone: 5,
  halo: 12,
};

/**
 * A full-bleed sparkline anchored to a tile's bottom edge: a smooth monotone
 * curve over a faint wash in the tile's accent hue, scaled to the tile width via
 * a viewBox. Pure SVG, no JS.
 *
 * Without a `domain` it scales from zero to the series maximum (the dashboard
 * vitals). With one, it draws against that range and `null` points are gaps:
 * each unbroken run is its own segment and a lone measured day is a dot.
 * `endDot` marks the latest measured value.
 *
 * Options for a tile where the trend is the point (all off by default, so the
 * vitals draw exactly as before): `height` in pixels, `strong` for a thicker
 * full-strength line, a fuller wash and a haloed end dot, and `lastGuide` for a
 * faint dotted line at the latest value, so earlier days read as above or
 * below today.
 */
export function Trend({
  data,
  accent,
  domain,
  endDot = false,
  height = TREND_H,
  strong = false,
  lastGuide = false,
}: {
  data: readonly (number | null)[];
  accent: string;
  domain?: { min: number; max: number };
  endDot?: boolean;
  height?: number;
  strong?: boolean;
  lastGuide?: boolean;
}) {
  const ink = strong ? INK_STRONG : INK_REGULAR;
  const measured = data.filter((value): value is number => value !== null);
  const blank = <div style={{ height }} aria-hidden />;

  if (!domain) {
    if (measured.length !== data.length || data.length < 2 || Math.max(...measured) <= 0) {
      return blank;
    }
    const max = Math.max(...measured, 1);
    const pts = toPoints(measured, { width: TREND_W, height: height - 4, padTop: 6, max });
    return (
      <TrendFrame accent={accent} height={height}>
        <TrendSegment pts={pts} height={height} ink={ink} />
      </TrendFrame>
    );
  }

  if (measured.length === 0) return blank;
  const span = Math.max(domain.max - domain.min, Number.EPSILON);
  const shifted = data.map((value) => (value === null ? 0 : Math.max(0, value - domain.min)));
  // Inset on the right so the latest day's dot (and its halo) is not cut by the tile's edge.
  const inset = strong ? 8 : 4;
  const padTop = strong ? 8 : 6;
  const all = toPoints(shifted, { width: TREND_W - inset, height: height - 4, padTop, max: span });
  const runs = gapSegments(data);
  const last = runs.at(-1)?.at(-1);
  return (
    <TrendFrame accent={accent} height={height}>
      {lastGuide && last !== undefined && <TrendGuide y={all[last][1]} />}
      {runs.map((run) =>
        run.length === 1 ? (
          <TrendDot key={run[0]} point={all[run[0]]} opacity={0.7} size={ink.lone} />
        ) : (
          <TrendSegment
            key={run[0]}
            pts={run.map((index) => all[index])}
            height={height}
            ink={ink}
          />
        ),
      )}
      {endDot && last !== undefined && ink.halo > 0 && (
        <TrendDot point={all[last]} opacity={0.22} size={ink.halo} />
      )}
      {endDot && last !== undefined && <TrendDot point={all[last]} opacity={1} size={ink.dot} />}
    </TrendFrame>
  );
}

function TrendFrame({
  accent,
  height,
  children,
}: {
  accent: string;
  height: number;
  children: ReactNode;
}) {
  return (
    <svg
      viewBox={`0 0 ${TREND_W} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      aria-hidden
      className="block"
      style={{ color: accent }}
    >
      {children}
    </svg>
  );
}

function TrendSegment({
  pts,
  height,
  ink,
}: {
  pts: readonly Point[];
  height: number;
  ink: TrendInk;
}) {
  return (
    <>
      <path
        d={areaPath(pts, height)}
        fill="currentColor"
        fillOpacity={ink.fillOpacity}
        stroke="none"
      />
      <path
        d={smoothPath(pts)}
        fill="none"
        stroke="currentColor"
        strokeOpacity={ink.strokeOpacity}
        strokeWidth={ink.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </>
  );
}

/** A faint dotted line across the whole trend at the latest value's height. */
function TrendGuide({ y }: { y: number }) {
  return (
    <line
      x1={0}
      x2={TREND_W}
      y1={y}
      y2={y}
      stroke="currentColor"
      strokeOpacity={0.35}
      strokeWidth={1}
      strokeDasharray="2 4"
      vectorEffect="non-scaling-stroke"
    />
  );
}

/**
 * A round dot that stays round under `preserveAspectRatio="none"`: a zero-length
 * stroke with a round cap, sized in screen pixels by the non-scaling stroke.
 */
function TrendDot({ point, opacity, size = 4 }: { point: Point; opacity: number; size?: number }) {
  return (
    <path
      d={`M${point[0]},${point[1]}h0.01`}
      stroke="currentColor"
      strokeOpacity={opacity}
      strokeWidth={size}
      strokeLinecap="round"
      vectorEffect="non-scaling-stroke"
    />
  );
}
