import { formatSharePercent as formatClaimShare } from "@/lib/readings/trace-signals/claims";
import {
  type AnyTurnShapeKind,
  type HealthTile,
  type Interval,
  OTEL_TURN_SHAPE_KINDS,
  type OtelTurnShapeKind,
  type SignalTier,
  type TilePoint,
  TURN_SHAPE_KINDS,
  type TurnShapeKind,
  type TurnShapeView,
} from "@/lib/readings/trace-signals/view";

/**
 * Display readings for the health band and the turn shapes, kept pure so the
 * components only lay things out.
 *
 * The page never prints a two-decimal figure: shares are whole percents, rates
 * one decimal, and intervals are rounded outward (low down, high up) so the
 * printed range never claims more precision than the Wilson bound behind it.
 */

/** What a tile prints while collecting: an en dash, never a zero. */
export const TILE_PLACEHOLDER = "–";

/** Floating-point slack for outward rounding, so 0.62 stays 62 and not 63. */
const EPSILON = 1e-9;

type TileUnit = HealthTile["unit"];

/* - Figures ----------------------------------------------------------------- */

/**
 * A share as a whole percent: 0.642 is "64%". One rule with the signal cards
 * (`claims.ts`): a tiny but non-zero share reads "<1%" and a share just short
 * of everything reads ">99%", so no figure rounds into a claim it cannot make.
 */
export function formatSharePercent(share: number): string {
  return formatClaimShare(share);
}

/** A per-100-turns rate with one decimal: 9.44 is "9.4". */
function formatRate(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

/** Dollars a run costs: "$0.03", "$1.20", or three decimals under a cent ("$0.004"). */
export function formatUsd(value: number): string {
  if (value > 0 && value < 0.001) return "<$0.001";
  return `$${value.toFixed(value >= 0.01 || value === 0 ? 2 : 3)}`;
}

/** Any unit's figure without its unit label. */
function formatValue(value: number, unit: TileUnit): string {
  if (unit === "share") return formatSharePercent(value);
  return unit === "usd" ? formatUsd(value) : formatRate(value);
}

export interface TileFigure {
  /** The big number: "64%", "9.4", or the placeholder while collecting. */
  value: string;
  /** A small unit after the figure; null for shares, whose "%" is the unit. */
  unit: string | null;
  /** False while the tile is collecting. */
  ready: boolean;
}

/** The small unit after a figure; shares carry their own "%". */
const TILE_UNIT_LABEL: Readonly<Record<TileUnit, string | null>> = {
  share: null,
  per_100_turns: "per 100 turns",
  per_turn: "per run",
  usd: null,
};

/** The headline figure of a tile, with its unit split out for smaller type. */
export function tileFigure(tile: Pick<HealthTile, "value" | "unit">): TileFigure {
  const unit = TILE_UNIT_LABEL[tile.unit];
  if (tile.value === null) return { value: TILE_PLACEHOLDER, unit, ready: false };
  return { value: formatValue(tile.value, tile.unit), unit, ready: true };
}

/* - Interval ---------------------------------------------------------------- */

/** Rounds an interval outward in display units: percent points or tenths. */
export function roundIntervalOutward(interval: Interval, unit: TileUnit): Interval {
  const scale = unit === "share" ? 100 : unit === "usd" ? 1_000 : 10;
  const low = Math.floor(interval.low * scale + EPSILON) / scale;
  const high = Math.ceil(interval.high * scale - EPSILON) / scale;
  return { low: Math.max(0, low), high: unit === "share" ? Math.min(1, high) : high };
}

/**
 * The interval under the figure, e.g. "61 to 67%" or "7.8 to 11.2". Null when
 * the tile is collecting or the engine computed no interval.
 */
export function tileIntervalText(
  tile: Pick<HealthTile, "value" | "interval" | "unit">,
): string | null {
  if (tile.value === null || !tile.interval) return null;
  const { low, high } = roundIntervalOutward(tile.interval, tile.unit);
  if (tile.unit === "share") {
    const lowPct = Math.round(low * 100);
    const highPct = Math.round(high * 100);
    return lowPct === highPct ? `${lowPct}%` : `${lowPct} to ${highPct}%`;
  }
  const format = (value: number) => formatValue(value, tile.unit);
  return low === high ? format(low) : `${format(low)} to ${format(high)}`;
}

/* - Delta ------------------------------------------------------------------- */

export type DeltaDirection = "up" | "down" | "flat";
export type DeltaTone = "good" | "bad" | "neutral";

export interface TileDelta {
  direction: DeltaDirection;
  /** Colour decision: a rise is good only when the tile says so. Flat is neutral. */
  tone: DeltaTone;
  /** Chip text with a true minus glyph: "+3 pts", "−2 pts", "+1.1", "0 pts". */
  text: string;
  /** The full reading for the tooltip and screen readers. */
  description: string;
}

/**
 * The change against the previous window, rounded in display units so the chip
 * never shows a colour for a change it prints as zero. Null while collecting or
 * without a previous window.
 */
export function tileDelta(
  tile: Pick<HealthTile, "value" | "delta" | "unit" | "upIsGood">,
): TileDelta | null {
  if (tile.value === null || tile.delta === null || !Number.isFinite(tile.delta)) return null;
  if (tile.unit === "usd") return usdDelta(tile.delta, tile.upIsGood);
  const share = tile.unit === "share";
  // Share deltas are in fractions; the chip speaks in percent points.
  const rounded = share ? Math.round(tile.delta * 100) : Math.round(tile.delta * 10) / 10;
  const magnitude = share ? `${Math.abs(rounded)}` : Math.abs(rounded).toFixed(1);
  const suffix = share ? " pts" : "";
  const spoken = share
    ? `${Math.abs(rounded)} ${Math.abs(rounded) === 1 ? "point" : "points"}`
    : magnitude;

  if (rounded === 0) {
    return {
      direction: "flat",
      tone: "neutral",
      text: `0${suffix}`,
      description: "No change on the previous window",
    };
  }
  const direction: DeltaDirection = rounded > 0 ? "up" : "down";
  const good = (direction === "up") === tile.upIsGood;
  return {
    direction,
    tone: good ? "good" : "bad",
    text: `${rounded > 0 ? "+" : "−"}${magnitude}${suffix}`,
    description: `${direction === "up" ? "Up" : "Down"} ${spoken} on the previous window, ${good ? "better" : "worse"}`,
  };
}

/** A change in dollars, rounded to a tenth of a cent: "+$0.004", "−$0.02". */
function usdDelta(delta: number, upIsGood: boolean): TileDelta {
  const rounded = Math.round(delta * 1_000) / 1_000;
  if (rounded === 0) {
    return {
      direction: "flat",
      tone: "neutral",
      text: "$0",
      description: "No change on the previous window",
    };
  }
  const direction: DeltaDirection = rounded > 0 ? "up" : "down";
  const good = (direction === "up") === upIsGood;
  const magnitude = formatUsd(Math.abs(rounded));
  return {
    direction,
    tone: good ? "good" : "bad",
    text: `${rounded > 0 ? "+" : "−"}${magnitude}`,
    description: `${direction === "up" ? "Up" : "Down"} ${magnitude} on the previous window, ${good ? "better" : "worse"}`,
  };
}

/* - Sparkline --------------------------------------------------------------- */

/** The smallest vertical span a sparkline shows, so noise on a flat line stays flat. */
const MIN_SPARK_SPAN: Record<TileUnit, number> = {
  share: 0.1,
  per_100_turns: 2,
  per_turn: 1,
  usd: 0.01,
};

export interface SparkDomain {
  min: number;
  max: number;
}

/**
 * The vertical range a tile's sparkline is drawn against: the data's own range,
 * widened to a minimum span and centred, so a week that moved three points
 * reads as a gentle slope and not a cliff. Null when there is nothing to draw.
 */
export function sparkDomain(series: readonly TilePoint[], unit: TileUnit): SparkDomain | null {
  const values = series.flatMap((point) => (point.value === null ? [] : [point.value]));
  if (values.length === 0) return null;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = Math.max(high - low, MIN_SPARK_SPAN[unit]) * 1.25;
  const centre = (low + high) / 2;
  const min = Math.max(0, centre - span / 2);
  return { min, max: min + span };
}

/**
 * A sentence for screen readers standing in for the sparkline, e.g. "Over 7
 * days: 61% to 67%." Null with fewer than two measured days.
 */
export function trendText(tile: Pick<HealthTile, "series" | "unit">): string | null {
  const measured = tile.series.filter((point) => point.value !== null);
  if (measured.length < 2) return null;
  const format = (value: number) => formatValue(value, tile.unit);
  const first = measured[0].value as number;
  const last = measured[measured.length - 1].value as number;
  return `Over ${tile.series.length} days: ${format(first)} to ${format(last)}.`;
}

/* - Tier -------------------------------------------------------------------- */

/**
 * The words behind a tile's tier glyph. Counted figures carry no glyph; the
 * other two tiers always say who decided.
 */
export function tierGlyphLabel(tier: SignalTier): string | null {
  switch (tier) {
    case "classifier":
      return "classifier scored";
    case "judge":
      return "model decided";
    default:
      return null;
  }
}

/* - Turn shapes ------------------------------------------------------------- */

/**
 * One mark of a pictogram: a search (circle), a tool run (square), an error
 * (cross), nothing, or `next`, a different tool run (a hollow square), which
 * the OpenTelemetry shapes use to tell a chain from the same tool again.
 */
export type ShapeMark = "search" | "tool" | "error" | "nothing" | "next";

/** Each shape drawn left to right, joined by arrows. */
export const SHAPE_MARKS: Readonly<Record<TurnShapeKind, readonly ShapeMark[]>> = {
  direct: ["search", "tool"],
  detour: ["search", "search", "tool"],
  dead_end: ["search", "nothing"],
  retry: ["tool", "error", "tool"],
  blind: ["tool"],
  repeat: ["tool", "tool"],
};

/** What each pictogram shows, for its `aria-label`. */
export const SHAPE_PICTURE_LABEL: Readonly<Record<TurnShapeKind, string>> = {
  direct: "Direct: searched once, then picked a tool",
  detour: "Detour: searched twice before picking a tool",
  dead_end: "Dead end: searched, then ran nothing",
  retry: "Retry: ran a tool, it failed, ran it again",
  blind: "Blind: ran a tool without searching",
  repeat: "Repeat: ran the same tool twice",
};

/** The OpenTelemetry shapes, drawn on the same lattice. */
export const OTEL_SHAPE_MARKS: Readonly<Record<OtelTurnShapeKind, readonly ShapeMark[]>> = {
  otel_direct: ["tool"],
  otel_chain: ["tool", "next", "next"],
  otel_retry: ["tool", "error", "tool"],
  otel_switched: ["tool", "error", "next"],
  otel_failed: ["tool", "error"],
};

export const OTEL_SHAPE_PICTURE_LABEL: Readonly<Record<OtelTurnShapeKind, string>> = {
  otel_direct: "Direct: one tool call, and it worked",
  otel_chain: "Chain: two or more tool calls, all worked",
  otel_retry: "Retry: a tool failed, then the agent ran it again",
  otel_switched: "Switched: a tool failed, then a different tool ran",
  otel_failed: "Failed: the last tool call failed",
};

/** The marks of any shape, SDK or OpenTelemetry. */
export function shapeMarks(shape: AnyTurnShapeKind): readonly ShapeMark[] {
  return shape in SHAPE_MARKS
    ? SHAPE_MARKS[shape as TurnShapeKind]
    : OTEL_SHAPE_MARKS[shape as OtelTurnShapeKind];
}

/** The `aria-label` of any shape's pictogram. */
export function shapePictureLabel(shape: AnyTurnShapeKind): string {
  return shape in SHAPE_PICTURE_LABEL
    ? SHAPE_PICTURE_LABEL[shape as TurnShapeKind]
    : OTEL_SHAPE_PICTURE_LABEL[shape as OtelTurnShapeKind];
}

const SHAPE_ORDER: Readonly<Record<AnyTurnShapeKind, number>> = Object.fromEntries(
  [...TURN_SHAPE_KINDS, ...OTEL_TURN_SHAPE_KINDS].map((kind, index) => [kind, index]),
) as Record<AnyTurnShapeKind, number>;

/**
 * Shapes by share, largest first; equal shares keep the catalog order (direct,
 * detour, dead end, retry, blind, repeat) so the list never reshuffles on a tie.
 * Returns a new array.
 */
export function sortShapes(shapes: readonly TurnShapeView[]): TurnShapeView[] {
  return [...shapes].sort(
    (a, b) => b.share - a.share || SHAPE_ORDER[a.shape] - SHAPE_ORDER[b.shape],
  );
}

/** "822 turns", "1 turn". */
export function formatTurnCount(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "turn" : "turns"}`;
}
