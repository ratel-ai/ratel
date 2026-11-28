import type { Bucket, MetricForm } from "@/lib/contracts/query";
import {
  METRIC_GROUP_LIMIT,
  nothingIsZero,
  type QueryWindow,
} from "@/lib/synthesis/metrics/catalog";
import type { MetricResult, MetricSeries, SqlResult } from "@/lib/synthesis/metrics/query";
import { formBucket } from "@/lib/views/dashboards/metric-rql";
import type { MetricChartKind } from "@/lib/views/dashboards/types";

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
          `Truncated: a cap of Ratel cut the result (the rows of a query with no LIMIT, the most rows of one query (1,000), or the size of a cell or of the rows). These are the first ${result.rows.length} rows. Add a LIMIT, a GROUP BY or a shorter range to read the rest.`,
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
  // Rows cut at the cap, newest first: the oldest bucket read and those before it are not whole.
  // They stay empty, never `nothing`: a 0 there would be a false drop.
  const cutAt =
    frame && result.truncated && result.rows.length > 0
      ? Math.min(...result.rows.map((row) => Date.parse(String(row[time]))))
      : null;
  const known = (index: number) => cutAt === null || (ordered[index] as number) > cutAt;
  const series = new Map<string, MetricSeries & { rank: number }>();
  const seriesOf = (key: string, groups: MetricSeries["groups"]) => {
    let found = series.get(key);
    if (!found) {
      found = {
        groups,
        total: null,
        samples: 0,
        values: ordered.map((_, index) => (known(index) ? nothing : null)),
        rank: 0,
      };
      series.set(key, found);
    }
    return found;
  };
  for (const row of result.rows) {
    const at = position.get(Date.parse(String(row[time])));
    // A row outside the window's buckets: the text narrowed or moved the time. A row of a bucket
    // the cut split counts in no bucket.
    if (at === undefined || !known(at)) continue;
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

/** Why a chart cannot draw the rows, by chart: null where it can. Table always can. */
export type ChartChoices = Readonly<Record<MetricChartKind, string | null>>;

/**
 * The chart a widget draws: the chosen one, or a table when its RQL rows cannot fill it (a text
 * written by hand, with the reason under it). A result of another kind draws its own chart.
 */
export function drawnChart<Chart extends string>(
  chart: Chart,
  result: { kind: string } | null,
): Chart | "table" {
  if (result?.kind !== "sql" || !(chart in CHART_KINDS)) return chart;
  return chartChoices(result as SqlResult)[chart as MetricChartKind] ? "table" : chart;
}

/**
 * Whether a card scrolls the widget's body inside it: a table, a number, and a list of text bars,
 * which grows with its rows, do. A line or a bar over time takes the card's height, and its readout
 * may reach out of it, so it does not.
 */
export function scrollsInCard(chart: string, result: { kind: string } | null): boolean {
  const drawn = drawnChart(chart, result);
  if (drawn !== "line" && drawn !== "bar") return true;
  return result?.kind === "sql" && sqlAsMetric(result as SqlResult) === null;
}

const CHART_KINDS: Readonly<Record<MetricChartKind, true>> = {
  line: true,
  bar: true,
  number: true,
  table: true,
};

/**
 * Which charts the rows of an RQL query fill, and why each other one does not. A table draws any
 * rows. A number needs one row with one number column. A line needs one time column and number
 * columns; a bar a time column or a text column for its bars. A text column next to the time
 * column, or a second text column next to the bars, is the series, with one number column.
 * Without `rows` (the columns of a compiled text), a number is judged by its columns only.
 */
export function chartChoices({
  columns,
  rows,
}: Pick<SqlResult, "columns"> & { rows?: readonly unknown[][] }): ChartChoices {
  const times = columns.filter(({ type }) => type === "timestamp");
  const texts = columns.filter(({ type }) => type === "text");
  const numbers = columns.filter(({ type }) => NUMERIC_TYPES.includes(type));
  const other = columns.find(
    ({ type }) => type !== "timestamp" && type !== "text" && !NUMERIC_TYPES.includes(type),
  );
  const noNumber = "A chart needs a number column, as count(*) or sum(...) gives.";
  const typed =
    other && `A chart reads time, text and number columns: ${other.name} is ${other.type}.`;
  const series = (seriesColumns: number) =>
    seriesColumns > 1
      ? `A chart reads one text column as its series: the rows have ${seriesColumns}.`
      : seriesColumns === 1 && numbers.length > 1
        ? "With a series column, a chart draws one number column."
        : null;
  const line =
    numbers.length === 0
      ? noNumber
      : times.length !== 1
        ? times.length === 0
          ? "A line needs one time column, as time_bucket(...) gives."
          : `A line reads one time column: the rows have ${times.length}.`
        : (typed ?? series(texts.length));
  const bar =
    times.length === 1 || numbers.length === 0
      ? line
      : times.length > 1
        ? `A bar reads one time or text column: the rows have ${times.length} time columns.`
        : texts.length === 0
          ? "A bar needs a time column or a text column for its bars."
          : (typed ?? series(texts.length - 1));
  const number =
    numbers.length !== 1
      ? `A number needs one number column: the rows have ${numbers.length}.`
      : rows && rows.length !== 1
        ? `A number needs one row: the query gives ${rows.length}.`
        : null;
  return { table: null, line, bar, number };
}

/** The chart a widget of an older version drew for its rows: a line where one fits, else a table. */
export function defaultChart(choices: ChartChoices): MetricChartKind {
  return choices.line === null ? "line" : "table";
}

/** The one number of a one-row result, or null. */
export function sqlNumber(result: SqlResult): number | null {
  const index = result.columns.findIndex(({ type }) => NUMERIC_TYPES.includes(type));
  const value = result.rows[0]?.[index];
  return typeof value === "number" ? value : null;
}

/** One bar of a chart of text bars, with the value of each series. */
export interface CategoryBar {
  label: string;
  values: { series: string | null; value: number | null }[];
}

/** The rows as bars, one per value of the first text column, in their order: for a bar chart. */
export function sqlAsCategories(result: SqlResult): CategoryBar[] {
  const texts = indexesOf(result, (type) => type === "text");
  const numbers = indexesOf(result, (type) => NUMERIC_TYPES.includes(type));
  const [label, series] = texts;
  const bars = new Map<string, CategoryBar>();
  for (const row of result.rows) {
    const name = String(row[label] ?? "null");
    const bar = bars.get(name) ?? { label: name, values: [] };
    bars.set(name, bar);
    for (const column of numbers) {
      const value = row[column];
      bar.values.push({
        series:
          series !== undefined
            ? String(row[series] ?? "null")
            : numbers.length > 1
              ? result.columns[column].name
              : null,
        value: typeof value === "number" ? value : null,
      });
    }
  }
  return [...bars.values()];
}

/** What the page knows of the ids a group-by gives: the task names by id. */
export interface GroupNames {
  taskNames?: Readonly<Record<string, string>>;
}

/**
 * The rows of a text of the form as the form's own result, so the widget draws as it did: the
 * buckets of the window filled, the groups by their value with a scorer's name as its label (and a
 * task's, from `names`: RQL gives its id), and the 10 highest. The text gives no count of rows behind a value: `samples` is 1 where there is
 * a value, 0 where there is nothing.
 */
export function formAsMetric(
  result: SqlResult,
  form: MetricForm,
  chart: MetricChartKind,
  window: QueryWindow,
  names: GroupNames = {},
): MetricResult {
  const [{ aggregation }] = form.measures;
  const nothing = nothingIsZero(aggregation) ? 0 : null;
  const bucket = formBucket(form, window);
  const groupsOf = (values: readonly string[]): MetricSeries["groups"] => {
    let at = 0;
    return form.dimensions.map((dimension) => {
      const value = values[at++] ?? "null";
      // A group-by scorer gives the id, then the name.
      if (dimension === "scorer") return { value, label: values[at++] ?? value };
      const task = dimension === "task" ? names.taskNames?.[value] : undefined;
      return task ? { value, label: task } : { value };
    });
  };
  const some = (value: number | null) => (value === null || value === nothing ? 0 : 1);
  if (chart === "line" || chart === "bar") {
    const drawn = sqlAsMetric(result, { window, bucket, nothing });
    return {
      kind: "metric",
      bucket,
      buckets: drawn?.buckets ?? [],
      series: (drawn?.series ?? []).map((series) => ({
        ...series,
        groups: groupsOf(series.groups.map(({ value }) => value)),
        samples: series.values.some((value) => some(value) > 0) ? 1 : 0,
      })),
    };
  }
  const series = result.rows.map((row): MetricSeries => {
    const value = row[row.length - 1];
    const total = typeof value === "number" ? value : null;
    return {
      groups: groupsOf(row.slice(0, -1).map((cell) => String(cell ?? "null"))),
      total,
      samples: some(total),
      values: [],
    };
  });
  return {
    kind: "metric",
    bucket,
    buckets: [],
    series:
      form.dimensions.length === 0
        ? [series[0] ?? { groups: [], total: nothing, samples: 0, values: [] }]
        : series.sort((a, b) => (b.total ?? 0) - (a.total ?? 0)).slice(0, METRIC_GROUP_LIMIT),
  };
}
