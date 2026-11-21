import type { EvidenceTier } from "@/lib/synthesis/quality/ground-truth";
import { creditFromHistogram, type RankHistogram } from "@/lib/synthesis/quality/metrics";
import type { CatalogFingerprintChange, QualityTrendRow } from "@/lib/synthesis/quality/snapshot";

/**
 * Shaping stored daily rows into what the trend chart draws.
 *
 * Pure, so the two decisions that matter here are testable rather than buried
 * in JSX:
 *
 *  1. A day with too few searches is a GAP, not a point. Plotting a 100% built
 *     from two searches next to a 62% built from ninety invites reading a spike
 *     that is one lucky afternoon. The line breaks instead.
 *  2. Every arm gets the same day axis, so a day where one arm has data and the
 *     other does not lines up rather than shifting one series sideways.
 */

/**
 * Below this many searches a day is not plotted.
 *
 * Five is low on purpose: the point is to exclude days that carry no signal at
 * all, not to smooth the series. Anything higher starts hiding real quiet-week
 * movement, which for a design partner is most weeks.
 */
export const MIN_DAY_SAMPLE = 5;

export interface TrendSeries {
  arm: string;
  points: { day: Date; value: number | null; n: number }[];
}

export type TrendMetric = "quality" | "containment";

/** One series per arm, over a shared day axis, for one tier and metric. */
export function buildTrendSeries(
  rows: readonly QualityTrendRow[],
  tier: EvidenceTier,
  metric: TrendMetric = "quality",
  minSample: number = MIN_DAY_SAMPLE,
): TrendSeries[] {
  const scoped = rows.filter((row) => row.tier === tier);
  const days = [...new Set(scoped.map((row) => row.day.getTime()))].sort(
    (left, right) => left - right,
  );
  const arms = [...new Set(scoped.map((row) => row.arm))].sort(compare);

  const byKey = new Map<string, QualityTrendRow>();
  for (const row of scoped) {
    byKey.set(`${row.arm}\u0000${row.day.getTime()}`, row);
  }

  return arms.map((arm) => ({
    arm,
    points: days.map((day) => {
      const row = byKey.get(`${arm}\u0000${day}`);
      const n = row?.n ?? 0;
      const value =
        row === undefined || n < minSample
          ? null
          : metric === "quality"
            ? creditOf(row) / n
            : row.contained / n;
      return { day: new Date(day), value, n };
    }),
  }));
}

/**
 * The trend the headline sits on: the answer key, or the tool the agent ran.
 *
 * The answer-key series only exists for days rolled up after the key did, so a
 * window from before it holds no `judged` rows at all. Days scored the old way,
 * against the incumbent's own first result, are stored as `reference` and are
 * never drawn: that was an assumption, and plotting it beside an answer would
 * put two different questions on one line. Falls back to `revealed` only when
 * the answer key has no plotted day in the window.
 */
export function headlineTrend(
  rows: readonly QualityTrendRow[],
  metric: TrendMetric = "quality",
  minSample: number = MIN_DAY_SAMPLE,
): { tier: "judged" | "revealed"; series: TrendSeries[] } {
  const judged = buildTrendSeries(rows, "judged", metric, minSample);
  if (hasPlottedDay(judged)) return { tier: "judged", series: judged };
  const revealed = buildTrendSeries(rows, "revealed", metric, minSample);
  if (hasPlottedDay(revealed)) return { tier: "revealed", series: revealed };
  return { tier: "judged", series: judged };
}

function hasPlottedDay(series: readonly TrendSeries[]): boolean {
  return series.some((entry) => entry.points.some((point) => point.value !== null));
}

/**
 * A day's summed credit, on the CURRENT curve.
 *
 * `credit_sum` is written by whichever curve was live on the pass that wrote
 * it, and the rollup only rewrites the last week, so archive days keep the old
 * sum forever. The histogram is curve-free, so credit is re-derived from it
 * whenever it accounts for the whole day, and the stored sum is only the
 * fallback for a row that carries no usable histogram.
 */
function creditOf(row: QualityTrendRow): number {
  const histogram = row.rankHistogram;
  if (histogram && histogramTotal(histogram) === row.n) {
    return creditFromHistogram(histogram);
  }
  return row.creditSum;
}

function histogramTotal(histogram: RankHistogram): number {
  let total = 0;
  for (const count of Object.values(histogram)) total += count;
  return total;
}

/**
 * Corpus changes worth drawing a rule for.
 *
 * Only a fingerprint that FIRST appeared inside the window is a change within
 * it; one that merely kept being seen is the corpus staying still, and marking
 * that would put a line on every chart.
 *
 * `firstRecordedAt` is when this project's very first fingerprint was written,
 * and the fingerprint that carries it is skipped: that timestamp is when we
 * STARTED LOOKING, not an edit anybody made. It has to be passed in rather than
 * inferred from `changes`, because that list is itself windowed, so its oldest
 * member is only the oldest we happened to load. Pass null when it is genuinely
 * unknown and nothing is skipped, which is the honest failure: a spurious rule
 * on the day we began recording is easier to spot than a real edit deleted.
 */
export function trendMarkers(
  changes: readonly CatalogFingerprintChange[],
  window: { since: Date; until: Date },
  firstRecordedAt: Date | null = null,
): { at: Date; label: string }[] {
  const started = firstRecordedAt?.getTime() ?? null;
  const inside = changes
    .filter(
      (change) =>
        change.firstSeenAt >= window.since &&
        change.firstSeenAt < window.until &&
        (started === null || change.firstSeenAt.getTime() > started),
    )
    .sort((left, right) => left.firstSeenAt.getTime() - right.firstSeenAt.getTime());

  return inside.map((change) => ({
    at: change.firstSeenAt,
    label: "catalog",
  }));
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
