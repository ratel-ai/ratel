import type { Bucket } from "@/lib/contracts/query";
import { METRIC_GROUP_LIMIT, type QueryWindow } from "@/lib/synthesis/metrics/catalog";
import type { MetricResult, MetricSeries, SqlResult } from "@/lib/synthesis/metrics/query";

/**
 * How the rows of an RQL query are drawn. Pure and safe for the browser. Rows with exactly one
 * timestamp column and at least one number column are a chart: the timestamps are the buckets,
 * and each number column is a series. With text columns too and one number column, each value of
 * the text columns is a series. Anything else is a table. A chart keeps the
 * `METRIC_GROUP_LIMIT` series of the highest sum, as the metric form keeps its groups.
 */

/**
 * What the text of a metric reads (`metricAsRql`), so its rows draw as the form draws them:
 * every bucket of the window, an empty one too, and a total only where a sum gives one.
 */
export interface SqlChartFrame {
  window: QueryWindow;
  /** The bucket of the text's `time_bucket`. */
  bucket: Bucket;
  /**
   * What an empty bucket shows: 0 for a count or a sum, nothing for a rate, an average or a
   * percentile. With 0 the total of a series is the sum of its buckets; else it has none.
   */
  nothing: 0 | null;
}

const NUMERIC_TYPES: readonly string[] = ["number", "integer"];
const STEP_MS: Record<Bucket, number> = { hour: 3_600_000, day: 86_400_000 };
const DAY_MS = STEP_MS.day;

/**
 * What a reader must know of the rows, as a chart or as a table: that they are not all. Empty
 * when the rows are whole.
 */
export function sqlResultNotes(result: SqlResult): string[] {
  return [
    ...(result.truncated
      ? [
          `Truncated: the query had more rows than its limit, or a cell or the rows were cut at the result cap. These are the first ${result.rows.length} rows. Add a LIMIT, a GROUP BY or a shorter range to read the rest.`,
        ]
      : []),
  ];
}

/** The rows as a metric result for `MetricChart`, or null when they are a table. */
export function sqlAsMetric(result: SqlResult, frame?: SqlChartFrame): MetricResult | null {
  const times = indexesOf(result, (type) => type === "timestamp");
  const numbers = indexesOf(result, (type) => NUMERIC_TYPES.includes(type));
  const others = result.columns
    .map((_, index) => index)
    .filter((index) => !numbers.includes(index) && !times.includes(index));
  if (times.length !== 1 || numbers.length === 0) return null;
  if (result.rows.length === 0 && !frame) return null;
  if (others.length > 0 && numbers.length > 1) return null;
  const [time] = times;
  const starts = new Map<number, string>();
  for (const at of frame ? bucketStarts(frame.window, frame.bucket) : []) {
    starts.set(at, new Date(at).toISOString());
  }
  for (const row of result.rows) {
    const at = Date.parse(String(row[time]));
    if (Number.isNaN(at)) return null;
    if (!frame) starts.set(at, new Date(at).toISOString());
  }
  const ordered = [...starts.keys()].sort((a, b) => a - b);
  const position = new Map(ordered.map((at, index) => [at, index]));
  const nothing = frame ? frame.nothing : null;
  const series = new Map<string, MetricSeries & { rank: number }>();
  const seriesOf = (key: string, groups: MetricSeries["groups"]) => {
    let found = series.get(key);
    if (!found) {
      found = { groups, total: null, samples: 0, values: ordered.map(() => nothing), rank: 0 };
      series.set(key, found);
    }
    return found;
  };
  for (const row of result.rows) {
    const at = position.get(Date.parse(String(row[time])));
    // A row outside the window's buckets: the text narrowed or moved the time.
    if (at === undefined) continue;
    for (const column of numbers) {
      const groups =
        others.length > 0
          ? others.map((index) => ({ value: String(row[index] ?? "null") }))
          : numbers.length > 1
            ? [{ value: result.columns[column].name }]
            : [];
      const target = seriesOf(JSON.stringify(groups), groups);
      const value = row[column];
      if (typeof value !== "number") continue;
      target.values[at] = (target.values[at] ?? 0) + value;
      target.rank += value;
      target.samples += 1;
    }
  }
  if (series.size === 0 && others.length === 0 && numbers.length === 1) seriesOf("[]", []);
  // A total is a sum of the buckets: only a count or a sum has one, as the form's total.
  const additive = !frame || frame.nothing === 0;
  return {
    kind: "metric",
    bucket: frame?.bucket ?? (ordered.every((at) => at % DAY_MS === 0) ? "day" : "hour"),
    buckets: ordered.map((at) => starts.get(at) as string),
    series: [...series.values()]
      .sort((a, b) => b.rank - a.rank)
      .slice(0, METRIC_GROUP_LIMIT)
      .map(({ rank, ...kept }) => ({
        ...kept,
        total: additive && kept.samples > 0 ? rank : additive && frame ? 0 : null,
      })),
  };
}

/** Every bucket the window touches, oldest first, as the metric form gives them. */
function bucketStarts({ since, until }: QueryWindow, bucket: Bucket): number[] {
  const step = STEP_MS[bucket];
  const starts: number[] = [];
  for (let at = Math.floor(since.getTime() / step) * step; at < until.getTime(); at += step) {
    starts.push(at);
  }
  return starts;
}

function indexesOf(result: SqlResult, keep: (type: string) => boolean): number[] {
  return result.columns.flatMap(({ type }, index) => (keep(type) ? [index] : []));
}
