import type { StatDelta } from "@ratel/design-system/stat-row";
import type { HealthTile, HealthTileKey, SignalTier } from "@/lib/readings/trace-signals/view";
import {
  tierGlyphLabel,
  tileDelta,
  tileFigure,
  tileIntervalText,
  trendText,
} from "@/lib/views/health/tiles";

/**
 * The Summary's readings as one StatRow: the band's tiles in plain words
 * (first try, finish rate, failed calls, wasted calls, and what each band
 * reads besides), each with its change on the window before.
 * Self-corrections have a row of their own below. A tile's details (likely
 * range, the sentence behind it, the days) open in a Panel. Pure.
 */

export const READING_PEEK_PREFIX = "reading:";

/** The band's labels, in the words the product uses. */
const LABEL: Readonly<Record<HealthTileKey, string>> = {
  first_try: "First try",
  detours: "Detours",
  junk: "Junk in lists",
  wasted_calls: "Wasted calls per 100 turns",
  completed: "Finish rate",
  failed_calls: "Failed calls",
  round_trips: "Model calls per run",
  cost_per_run: "Cost per run",
  model_calls: "Model calls per run",
};

/** What each reading means, in one line, for its panel. */
const MEANING: Readonly<Record<HealthTileKey, string>> = {
  first_try: "Turns where the first search listed the tool the agent then ran.",
  detours: "Turns where the agent searched again before running a tool.",
  junk: "Listed tools that could not have answered the ask.",
  wasted_calls: "Repeats and retries of the same tool, per 100 turns.",
  completed: "Runs that ended without a failed call.",
  failed_calls: "Tool calls that failed.",
  round_trips: "Calls to the model a run makes.",
  cost_per_run: "What a run costs in model calls, at the model's price.",
  model_calls: "Calls to the model a run makes.",
};

const COMPARED = "vs the window before";

export interface ReadingView {
  key: string;
  label: string;
  /** "64%", "5.7", or a dash while there is no reading. */
  value: string;
  delta: StatDelta | null;
  /** The sentence under the value: what it is counted from. */
  hint: string | null;
  /** Seven days, oldest first; null for a reading without days. */
  trend: readonly (number | null)[] | null;
  trendLabel: string | null;
  /** For the panel: what it means, its likely range, who decided it, and the days. */
  meaning: string;
  range: string | null;
  decidedBy: string;
  days: readonly { day: string; value: string }[];
  peek: string;
}

function deltaOf(tile: HealthTile): StatDelta | null {
  const delta = tileDelta(tile);
  if (!delta) return null;
  return {
    value: delta.text,
    direction: delta.direction,
    good: delta.tone === "good" ? true : delta.tone === "bad" ? false : null,
    label: COMPARED,
  };
}

function decidedBy(tier: SignalTier): string {
  const label = tierGlyphLabel(tier);
  return label === null
    ? "Counted from your traces"
    : tier === "judge"
      ? "Judged"
      : "Scored by a classifier";
}

function dayValue(tile: HealthTile, value: number | null): string {
  return tileFigure({ value, unit: tile.unit }).value;
}

export function tileReading(tile: HealthTile): ReadingView {
  const figure = tileFigure(tile);
  const measured = tile.series.filter((point) => point.value !== null);
  return {
    key: tile.key,
    label: LABEL[tile.key],
    value: figure.value,
    delta: deltaOf(tile),
    hint: tile.sub.trim() || null,
    trend: figure.ready && measured.length > 0 ? tile.series.map((point) => point.value) : null,
    trendLabel: figure.ready ? (trendText(tile) ?? "One day measured so far.") : null,
    meaning: MEANING[tile.key],
    range: tileIntervalText(tile),
    decidedBy: decidedBy(tile.tier),
    days: tile.series.map((point) => ({ day: point.day, value: dayValue(tile, point.value) })),
    peek: `${READING_PEEK_PREFIX}${tile.key}`,
  };
}

/** The row: the band's tiles, five at most, as StatRow takes. */
export function readingViews(tiles: readonly HealthTile[]): ReadingView[] {
  return tiles.slice(0, 5).map(tileReading);
}

/** The reading a `?peek=` names, or null for another panel's. */
export function peekedReading(peek: string | null): string | null {
  return peek?.startsWith(READING_PEEK_PREFIX)
    ? peek.slice(READING_PEEK_PREFIX.length) || null
    : null;
}
