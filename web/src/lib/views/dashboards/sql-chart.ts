import type { MetricResult, MetricSeries, SqlResult } from "@/lib/synthesis/metrics/query";

/**
 * How the rows of an RQL query are drawn. Pure and safe for the browser. Rows with exactly one
 * timestamp column and at least one number column are a chart: the timestamps are the buckets,
 * and each number column is a series. With text columns too and one number column, each value of
 * the text columns is a series. Anything else is a table.
 */

const NUMERIC_TYPES: readonly string[] = ["number", "integer"];
const DAY_MS = 86_400_000;

/** The rows as a metric result for `MetricChart`, or null when they are a table. */
export function sqlAsMetric(result: SqlResult): MetricResult | null {
  const times = indexesOf(result, (type) => type === "timestamp");
  const numbers = indexesOf(result, (type) => NUMERIC_TYPES.includes(type));
  const others = result.columns
    .map((_, index) => index)
    .filter((index) => !numbers.includes(index) && !times.includes(index));
  if (times.length !== 1 || numbers.length === 0 || result.rows.length === 0) return null;
  if (others.length > 0 && numbers.length > 1) return null;
  const [time] = times;
  const starts = new Map<number, string>();
  for (const row of result.rows) {
    const at = Date.parse(String(row[time]));
    if (Number.isNaN(at)) return null;
    starts.set(at, new Date(at).toISOString());
  }
  const ordered = [...starts.keys()].sort((a, b) => a - b);
  const position = new Map(ordered.map((at, index) => [at, index]));
  const series = new Map<string, MetricSeries>();
  const seriesOf = (key: string, groups: MetricSeries["groups"]) => {
    let found = series.get(key);
    if (!found) {
      found = { groups, total: null, samples: 0, values: ordered.map(() => null) };
      series.set(key, found);
    }
    return found;
  };
  for (const row of result.rows) {
    const at = position.get(Date.parse(String(row[time]))) as number;
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
      target.total = (target.total ?? 0) + value;
      target.samples += 1;
    }
  }
  return {
    kind: "metric",
    bucket: ordered.every((at) => at % DAY_MS === 0) ? "day" : "hour",
    buckets: ordered.map((at) => starts.get(at) as string),
    series: [...series.values()].sort((a, b) => (b.total ?? 0) - (a.total ?? 0)),
  };
}

function indexesOf(result: SqlResult, keep: (type: string) => boolean): number[] {
  return result.columns.flatMap(({ type }, index) => (keep(type) ? [index] : []));
}
