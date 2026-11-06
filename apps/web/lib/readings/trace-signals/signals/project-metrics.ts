import { turnDetour, turnFirstTry } from "@/lib/ledger/same-ask";
import { DEFAULT_FLOORS, type Floors } from "@/lib/readings/trace-signals/signals/catalog";
import {
  addLinkedDays,
  type LinkedDay,
  linkedDayOf,
} from "@/lib/readings/trace-signals/signals/linked-day";
import {
  addOtelDays,
  type OtelDay,
  type OtelTurnExtras,
  otelDayOf,
} from "@/lib/readings/trace-signals/signals/otel-day";
import { wilson } from "@/lib/readings/trace-signals/signals/severity";
import {
  classifyTurnShape,
  dayOf,
  isInvoke,
  isListingSearch,
  junkOfSearch,
  turnWaste,
  usesOtelShapes,
} from "@/lib/readings/trace-signals/signals/turn-facts";
import type { SignalTurn } from "@/lib/readings/trace-signals/signals/types";
import type {
  CaptureLevel,
  HealthTile,
  Interval,
  TilePoint,
  TurnShapeKind,
  TurnShapeView,
  TurnSourceMix,
} from "@/lib/readings/trace-signals/view";
import { TURN_SHAPE_KINDS } from "@/lib/readings/trace-signals/view";

/**
 * The project-level readings behind the health band and the turn shapes, kept
 * as UTC daily buckets of raw counts. A run stores the buckets (in
 * `trace_signal_runs.summary`) and the page sums whichever days its window
 * covers, so one run serves the 7, 30 and 90 day views, their 7-day
 * sparklines, and the delta against the previous window, without the page
 * ever rescanning turns. Counts only; no ids, no text.
 */

export type ShapeCounts = Record<TurnShapeKind, number>;

export interface DayBucket {
  day: string;
  turns: number;
  mix: TurnSourceMix;
  firstTry: number;
  firstTryN: number;
  detours: number;
  detourN: number;
  junk: number;
  scored: number;
  wasted: number;
  /** Turns whose shape is measurable; the shapes sum to this. */
  shaped: number;
  shapes: ShapeCounts;
  searches: number;
  /** Searches that carried query text (a query hash exists only then). */
  capturedSearches: number;
  /** Runtime-lane turns carrying tool ids (hits or invocation targets). */
  toolDetailTurns: number;
  /**
   * The day's OpenTelemetry turns (`otel-day.ts`): runs that called a tool
   * and never searched, which take no SDK shape. Absent on days without one,
   * so an SDK project's buckets stay exactly as before.
   */
  otel?: OtelDay;
  /**
   * The day's SDK runs linked to OpenTelemetry model calls (`linked-day.ts`):
   * their cost and model calls. Absent on days without one.
   */
  linked?: LinkedDay;
}

function emptyShapes(): ShapeCounts {
  return { direct: 0, detour: 0, dead_end: 0, retry: 0, blind: 0, repeat: 0 };
}

export function emptyBucket(day: string): DayBucket {
  return {
    day,
    turns: 0,
    mix: { declared: 0, inferred: 0, otlp: 0 },
    firstTry: 0,
    firstTryN: 0,
    detours: 0,
    detourN: 0,
    junk: 0,
    scored: 0,
    wasted: 0,
    shaped: 0,
    shapes: emptyShapes(),
    searches: 0,
    capturedSearches: 0,
    toolDetailTurns: 0,
  };
}

/**
 * One turn's contribution to its day, as a bucket of its own. A turn told in
 * the OpenTelemetry vocabulary takes no SDK shape and adds to `otel` instead;
 * `extras` carries what OTel recorded beside its steps (round trips, capture).
 */
export function turnBucket(
  turn: SignalTurn,
  floors: Floors = DEFAULT_FLOORS,
  extras?: OtelTurnExtras,
): DayBucket {
  const bucket = emptyBucket(dayOf(turn.endedAt));
  const searches = turn.steps.filter((step) => step.kind === "search");
  const waste = turnWaste(turn, floors.no_follow_through.withinMs);
  // Read from the steps, not the stored turn columns, so a ledger built under
  // an older rule reads the same as a replay.
  const firstTry = turnFirstTry(turn.steps);
  const otel = usesOtelShapes(turn);
  const shape = otel ? null : classifyTurnShape(turn);
  const junk = searches.map(junkOfSearch).filter((j) => j !== null);
  const toolDetail =
    turn.lane === "runtime" &&
    turn.steps.some(
      (step) => isInvoke(step) || (isListingSearch(step) && (step.hitIds?.length ?? 0) > 0),
    );
  return {
    ...bucket,
    turns: 1,
    mix: { ...bucket.mix, [turn.turnSource]: 1 },
    firstTry: firstTry === true ? 1 : 0,
    firstTryN: firstTry === null ? 0 : 1,
    detours: searches.length > 0 && turnDetour(turn.steps) ? 1 : 0,
    detourN: searches.length > 0 ? 1 : 0,
    junk: junk.reduce((sum, j) => sum + j.junk, 0),
    scored: junk.reduce((sum, j) => sum + j.scored, 0),
    wasted: waste.repeats + waste.retries + waste.noFollow,
    shaped: shape === null ? 0 : 1,
    shapes: shape === null ? emptyShapes() : { ...emptyShapes(), [shape]: 1 },
    searches: searches.length,
    capturedSearches: searches.filter((step) => step.queryHash !== null).length,
    toolDetailTurns: toolDetail ? 1 : 0,
    ...(otel ? { otel: otelDayOf(turn, extras) } : {}),
    ...(turn.linked ? { linked: linkedDayOf(turn.linked) } : {}),
  };
}

/** Two buckets added together (same day or not; the left day wins). */
export function addBuckets(left: DayBucket, right: DayBucket): DayBucket {
  const shapes = Object.fromEntries(
    TURN_SHAPE_KINDS.map((kind) => [kind, left.shapes[kind] + right.shapes[kind]]),
  ) as ShapeCounts;
  const otel = addOtelDays(left.otel, right.otel);
  const linked = addLinkedDays(left.linked, right.linked);
  return {
    day: left.day,
    turns: left.turns + right.turns,
    mix: {
      declared: left.mix.declared + right.mix.declared,
      inferred: left.mix.inferred + right.mix.inferred,
      otlp: left.mix.otlp + right.mix.otlp,
    },
    firstTry: left.firstTry + right.firstTry,
    firstTryN: left.firstTryN + right.firstTryN,
    detours: left.detours + right.detours,
    detourN: left.detourN + right.detourN,
    junk: left.junk + right.junk,
    scored: left.scored + right.scored,
    wasted: left.wasted + right.wasted,
    shaped: left.shaped + right.shaped,
    shapes,
    searches: left.searches + right.searches,
    capturedSearches: left.capturedSearches + right.capturedSearches,
    toolDetailTurns: left.toolDetailTurns + right.toolDetailTurns,
    ...(otel ? { otel } : {}),
    ...(linked ? { linked } : {}),
  };
}

/** Folds turns into daily buckets as they stream by. */
export class DailyBuckets {
  private readonly days = new Map<string, DayBucket>();

  add(turn: SignalTurn, floors: Floors = DEFAULT_FLOORS, extras?: OtelTurnExtras): void {
    const bucket = turnBucket(turn, floors, extras);
    const existing = this.days.get(bucket.day);
    this.days.set(bucket.day, existing ? addBuckets(existing, bucket) : bucket);
  }

  /** Oldest first. */
  values(): DayBucket[] {
    return [...this.days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  }
}

/* - Windows ----------------------------------------------------------------- */

const DAY_MS = 86_400_000;

/** The `days` UTC days ending on the day before `end` (the window's last day), oldest first. */
export function windowDays(end: Date, days: number): string[] {
  const last = end.getTime() - 1;
  return Array.from({ length: days }, (_, i) => dayOf(new Date(last - (days - 1 - i) * DAY_MS)));
}

/**
 * How many days a run's window actually has evidence for:
 * `min(window, days since the project's first turn)`. Counted in the same UTC
 * days as {@link windowDays}, from the first day with a turn to the window's
 * last day; a turn in the buckets from before the window (the run scans extra
 * comparison days) means the project is older than the window, which is then
 * covered in full. A run over 90 days of a project that has sent turns for
 * three weeks reads 22 days (the partial first day counts), and its cards say
 * so. Zero when the buckets hold no turns at all.
 */
export function evidenceSpanDays(buckets: readonly DayBucket[], end: Date, days: number): number {
  const window = windowDays(end, days);
  const withTurns = buckets.filter((b) => b.turns > 0).map((b) => b.day);
  if (withTurns.length === 0) return 0;
  if (withTurns.some((day) => day < window[0]!)) return days;
  const inWindow = new Set(withTurns);
  const first = window.findIndex((day) => inWindow.has(day));
  return first < 0 ? 0 : days - first;
}

/** The sum of the buckets on the given days. */
export function totalOver(buckets: readonly DayBucket[], days: readonly string[]): DayBucket {
  const wanted = new Set(days);
  return buckets
    .filter((b) => wanted.has(b.day))
    .reduce((sum, b) => addBuckets(sum, b), emptyBucket(days[0] ?? ""));
}

/* - Tiles ------------------------------------------------------------------- */

type TileKey = HealthTile["key"];

/** One tile's figure over a span of buckets. */
export interface TileReading {
  value: number | null;
  interval: Interval | null;
  n: number;
  sub: string;
}

const fmt = (n: number): string => n.toLocaleString("en-US");

/**
 * A score (Wilson-style) interval for a Poisson count, as a rate per 100 turns:
 * `(c + z²/2 ± z·sqrt(c + z²/4)) / turns`. Unlike `c ± z·sqrt(c)` it stays
 * above zero and keeps a width when the count is 0 (upper bound ~3.84).
 */
export function rateInterval(count: number, turns: number): Interval | null {
  if (turns <= 0) return null;
  const z = 1.96;
  const centre = count + (z * z) / 2;
  const margin = z * Math.sqrt(count + (z * z) / 4);
  return {
    low: (Math.max(0, centre - margin) / turns) * 100,
    high: ((centre + margin) / turns) * 100,
  };
}

export function readTile(key: TileKey, t: DayBucket): TileReading {
  switch (key) {
    case "first_try":
      return {
        value: t.firstTryN > 0 ? t.firstTry / t.firstTryN : null,
        interval: wilson(t.firstTry, t.firstTryN),
        n: t.firstTryN,
        sub: `${fmt(t.firstTry)} of ${fmt(t.firstTryN)} turns found each tool on the first search for it.`,
      };
    case "detours":
      return {
        value: t.detourN > 0 ? t.detours / t.detourN : null,
        interval: wilson(t.detours, t.detourN),
        n: t.detourN,
        sub: `${fmt(t.detours)} of ${fmt(t.detourN)} turns that searched had to search again for the same thing.`,
      };
    case "junk":
      return {
        value: t.scored > 0 ? t.junk / t.scored : null,
        interval: wilson(t.junk, t.scored),
        n: t.scored,
        sub: `${fmt(t.junk)} of ${fmt(t.scored)} listed hits scored well below the top hit.`,
      };
    case "wasted_calls":
      return {
        value: t.turns > 0 ? (t.wasted / t.turns) * 100 : null,
        interval: rateInterval(t.wasted, t.turns),
        n: t.turns,
        sub: `${fmt(t.wasted)} repeats, retries and calls followed by a search for the same thing.`,
      };
    default:
      // The OpenTelemetry tiles are read in `otel-metrics.ts`.
      return { value: null, interval: null, n: 0, sub: "" };
  }
}

/** What a tile is, before it is read. */
export interface TileMeta {
  key: TileKey;
  label: string;
  unit: HealthTile["unit"];
  upIsGood: boolean;
}

export const TILE_META: ReadonlyArray<TileMeta> = [
  { key: "first_try", label: "First try", unit: "share", upIsGood: true },
  { key: "detours", label: "Detours", unit: "share", upIsGood: false },
  { key: "junk", label: "Junk in lists", unit: "share", upIsGood: false },
  { key: "wasted_calls", label: "Wasted calls", unit: "per_100_turns", upIsGood: false },
];

export interface TileWindow {
  /** End of the page window (exclusive): the run's window end. */
  end: Date;
  days: number;
  /** First day the buckets cover; a previous window before it has no delta. */
  coveredFrom: string;
  /** Turns needed before tiles show figures. */
  floor: number;
}

/** The four tiles over a window: figure, interval, 7-day series, delta. */
export function tilesFor(buckets: readonly DayBucket[], w: TileWindow): HealthTile[] {
  return tilesWith(buckets, w, TILE_META, readTile);
}

/** Any set of tiles over a window, each read by `read`: figure, interval, 7-day series, delta. */
export function tilesWith(
  buckets: readonly DayBucket[],
  w: TileWindow,
  metas: readonly TileMeta[],
  read: (key: TileKey, bucket: DayBucket) => TileReading,
): HealthTile[] {
  const current = windowDays(w.end, w.days);
  const previous = windowDays(new Date(w.end.getTime() - w.days * DAY_MS), w.days);
  const total = totalOver(buckets, current);
  const prevCovered = (previous[0] ?? "") >= w.coveredFrom;
  const prevTotal = prevCovered ? totalOver(buckets, previous) : null;
  const byDay = new Map(buckets.map((b) => [b.day, b]));
  const ready = total.turns >= w.floor;
  return metas.map((meta) => {
    const reading = read(meta.key, total);
    const prev = prevTotal && prevTotal.turns > 0 ? read(meta.key, prevTotal).value : null;
    const series: TilePoint[] = windowDays(w.end, 7).map((day) => {
      const bucket = byDay.get(day);
      return { day, value: bucket ? read(meta.key, bucket).value : null };
    });
    return {
      key: meta.key,
      label: meta.label,
      unit: meta.unit,
      upIsGood: meta.upIsGood,
      tier: "deterministic" as const,
      value: ready ? reading.value : null,
      interval: ready ? reading.interval : null,
      sub: ready ? reading.sub : "Waiting for enough turns.",
      delta: ready && reading.value !== null && prev !== null ? reading.value - prev : null,
      series,
      n: reading.n,
    };
  });
}

/* - Shapes and capture ------------------------------------------------------ */

const SHAPE_COPY: Record<TurnShapeKind, { label: string; description: string }> = {
  direct: { label: "Direct", description: "Searched once and ran the right tool." },
  detour: { label: "Detour", description: "Searched again for the same thing." },
  dead_end: { label: "Dead end", description: "Searched and ran nothing." },
  retry: { label: "Retry", description: "Ran a tool, it failed, ran it again." },
  blind: { label: "Blind", description: "Ran a tool without searching." },
  repeat: { label: "Repeat", description: "Ran the same tool again in one turn." },
};

/** The six shapes over a window's total, sorted by count (ties in catalog order). */
export function shapesFor(total: DayBucket): TurnShapeView[] {
  return TURN_SHAPE_KINDS.map((shape) => ({
    shape,
    ...SHAPE_COPY[shape],
    count: total.shapes[shape],
    share: total.shaped === 0 ? 0 : total.shapes[shape] / total.shaped,
  })).sort((a, b) => b.count - a.count);
}

/**
 * How much of each turn the project sends, over a window's total:
 * - `content` when at least half its searches carried query text (the ledger
 *   keeps a salted hash only when text was sent, so a hash means captured);
 * - `tools` when runtime-lane turns carry tool ids (hits or invocation targets);
 * - `events` otherwise: OTLP-only projects, or runtime rows without tool detail.
 */
export function captureLevelOf(total: DayBucket): CaptureLevel {
  if (total.searches > 0 && total.capturedSearches * 2 >= total.searches) return "content";
  if (total.toolDetailTurns > 0) return "tools";
  return "events";
}
