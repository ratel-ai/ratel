import {
  type Aggregation,
  type Bucket,
  type Dimension,
  type MeasureId,
  type MetricDimension,
  type MetricForm,
  propertyOf,
  QUERY_VERSION,
  type SqlQuery,
} from "@/lib/contracts/query";
import { getMetric, metricBucket, type QueryWindow } from "@/lib/synthesis/metrics/catalog";
import { RQL_LIMITS } from "@/lib/synthesis/rql/domain/limits";
import { RQL_VERSION } from "@/lib/synthesis/rql/domain/version";
import { clausesOf } from "@/lib/synthesis/traces/trace-filter-clauses";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import type { MetricChartKind } from "@/lib/views/dashboards/types";

/**
 * The RQL text of the metric form: a metric widget is RQL, and the form is a quick way to write
 * it. Pure and safe for the browser. Every selection of the form has a text: it reads the same
 * rows over the same window, and gives the same numbers as the form compiler
 * (`metric-rql-parity.integration.test.ts`). A line or a bar gives one row per bucket and group,
 * a number one row, a table one row per group. The text keeps every group, where the form keeps
 * the 10 highest: the code that draws the rows keeps them (`sql-chart.ts`), and fills the empty
 * buckets. A text is the form's while it is the text of its selection; an edit makes it Custom.
 */

/** How the scorer filter of a selection is written: by id, or by name in a document. */
export interface MetricRqlOptions {
  /** The scorer's name, to write `scorer = 'name'`: a document carries no database id. */
  scorerName?: string;
}

type Table = "traces" | "scores" | "prompts";

interface MeasureRead {
  table: Table;
  /** The number each row gives: `*` for a count of rows. */
  value: string;
  /** The condition a rate reads. */
  condition?: string;
  /** The rows the measure applies to. */
  where?: string;
}

/** What each measure reads, as the form compiler reads it (`synthesis/metrics/query.ts`). */
const MEASURES: Record<MeasureId, MeasureRead> = {
  trace_count: { table: "traces", value: "*" },
  error_rate: { table: "traces", value: "*", condition: "coalesce(root_error, has_error)" },
  latency: { table: "traces", value: "duration_ms" },
  tokens: { table: "traces", value: "input_tokens + output_tokens" },
  cost: { table: "traces", value: "cost_usd" },
  context_tokens: { table: "prompts", value: "context_tokens" },
  context_cost: { table: "prompts", value: "cost_usd" },
  scorer_pass_rate: {
    table: "scores",
    value: "*",
    condition: "passed",
    where: "passed is not null",
  },
  scorer_average: { table: "scores", value: "value", where: "passed is null" },
  scorer_count: { table: "scores", value: "*" },
};

const AGGREGATES: Record<Aggregation, (read: MeasureRead) => string> = {
  count: ({ value }) => `count(${value})`,
  rate: ({ condition }) => `rate(${condition ?? "true"})`,
  // The form gives 0 for a sum of no rows, as an alert reads it.
  sum: ({ value }) => `coalesce(sum(${value}), 0)`,
  avg: ({ value }) => `avg(${value})`,
  p50: ({ value }) => `p50(${value})`,
  p95: ({ value }) => `p95(${value})`,
};

/** The output columns of each dimension. A list is read once per value with `each`. */
const GROUP_COLUMNS: Record<Dimension, readonly string[]> = {
  model: ["each(models) as model"],
  tool: ["each(tools) as tool"],
  agent: ["each(agents) as agent"],
  service: ["service_name"],
  environment: ["environment"],
  user: ["user_id"],
  session: ["session_id"],
  task: ["each(tasks) as task"],
  scorer: ["scorer_id", "scorer"],
};

/** The list each list dimension reads, and the filter key that names its values. */
const LIST_DIMENSIONS: Partial<
  Record<
    Dimension,
    { list: string; values: (filter: TraceFilter) => readonly string[] | undefined }
  >
> = {
  model: { list: "models", values: (filter) => filter.models },
  tool: { list: "tools", values: (filter) => filter.tools },
  agent: { list: "agents", values: (filter) => filter.agents },
  task: { list: "tasks", values: (filter) => filter.tasks },
};

const TIME_COLUMNS: Record<Table, string> = {
  traces: "started_at",
  scores: "trace_started_at",
  prompts: "occurred_at",
};

const BUCKET_INTERVALS: Record<Bucket, string> = { hour: "1 hour", day: "1 day" };

/** The reserved words of the parser that cannot be a bare output name. */
const RESERVED = new Set(
  (
    "all analyse analyze and any array as asc asymmetric between both case cast check collate column " +
    "constraint create current_date current_role current_time current_timestamp current_user default " +
    "deferrable desc distinct do else end except false fetch for foreign from grant group having ilike " +
    "in initially intersect into is lateral leading like limit localtime localtimestamp not null nulls " +
    "offset on only or order placing primary references returning select session_user some symmetric " +
    "table then to trailing true union unique user using variadic when where window with"
  ).split(" "),
);

/** The RQL text of a selection drawn as `chart`, read by `bucket` for a line or a bar. */
export function metricAsRql(
  form: MetricForm,
  chart: MetricChartKind,
  bucket: Bucket,
  options: MetricRqlOptions = {},
): string {
  const {
    measures: [{ measure, aggregation }],
    dimensions,
    filters: { scorer, ...filter },
  } = form;
  const read = MEASURES[measure];
  const columns = groupColumns(dimensions);
  const groups = columns.map(({ select }) => select);
  const keys = columns.map(({ key }) => key);
  const timed = chart === "line" || chart === "bar";
  const selected = [
    ...(timed
      ? [`time_bucket('${BUCKET_INTERVALS[bucket]}', ${TIME_COLUMNS[read.table]}) as bucket`]
      : []),
    ...groups,
    `${AGGREGATES[aggregation](read)} as value`,
  ];
  const where = [
    ...(read.where ? [read.where] : []),
    ...(scorer
      ? [
          options.scorerName === undefined
            ? `scorer_id = ${literal(scorer.id)}`
            : `scorer = ${literal(options.scorerName)}`,
        ]
      : []),
    ...columns.filter(({ list }) => !list).map(({ value }) => `${value} is not null`),
    // The context measures have no trace: the form applies no trace filter to them.
    ...(read.table === "prompts" ? [] : filterConditions(filter, read.table)),
    ...(read.table === "prompts" ? [] : listGroupConditions(dimensions, filter)),
  ];
  const grouped = [...(timed ? ["bucket"] : []), ...keys];
  // Newest buckets first: when the rows pass the limit, the cut drops the oldest, and the chart
  // puts the buckets back in time order.
  const ordered = timed ? ["bucket desc", ...keys] : keys.length > 0 ? ["value desc"] : [];
  return [
    `select ${selected.join(", ")}`,
    `from ${read.table}`,
    ...(where.length > 0 ? [`where ${where.join("\n  and ")}`] : []),
    ...(grouped.length > 0 ? [`group by ${grouped.join(", ")}`] : []),
    ...(ordered.length > 0 ? [`order by ${ordered.join(", ")}`] : []),
    ...(grouped.length > 0 ? [`limit ${RQL_LIMITS.maxLimit}`] : []),
  ].join("\n");
}

/** A query of kind sql that the form wrote: its selection, and its text for `chart` and `bucket`. */
export function formQuery(form: MetricForm, chart: MetricChartKind, bucket: Bucket): SqlQuery {
  return {
    version: QUERY_VERSION,
    kind: "sql",
    text: metricAsRql(form, chart, bucket),
    rqlVersion: RQL_VERSION,
    form,
  };
}

/**
 * The bucket a text was written with when it is still the text of its form's selection, or null
 * when it is not: an edited text is Custom. The texts are compared after the same normalisation
 * (runs of white space are one space); RQL is never parsed back into a form.
 */
export function formBucketOf(
  query: Pick<SqlQuery, "text" | "form">,
  chart: MetricChartKind,
  options: MetricRqlOptions = {},
): Bucket | null {
  const { form } = query;
  if (!form) return null;
  const text = normalized(query.text);
  for (const bucket of ["hour", "day"] as const)
    if (normalized(metricAsRql(form, chart, bucket, options)) === text) return bucket;
  return null;
}

/** Whether the text is still its form's: the Metric dropdown shows the measure, else Custom. */
export function isFormText(
  query: Pick<SqlQuery, "text" | "form">,
  chart: MetricChartKind,
): boolean {
  return formBucketOf(query, chart) !== null;
}

/**
 * The text that runs over a window. A text of the form follows the window, as the form does: a
 * selection with no bucket of its own reads hours for a few days and days for more. A Custom
 * text runs as it is written.
 */
export function textToRun(
  query: Pick<SqlQuery, "text" | "form">,
  chart: MetricChartKind,
  window: QueryWindow,
): string {
  const { form } = query;
  if (!form || !isFormText(query, chart)) return query.text;
  return metricAsRql(form, chart, formBucket(form, window));
}

/** The bucket a selection reads over a window: its own, or the window's. */
export function formBucket(form: MetricForm, window: QueryWindow): Bucket {
  const metric = getMetric(form.measures[0].measure);
  return form.bucket ?? (metric ? metricBucket(metric, window) : "day");
}

function normalized(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

interface GroupColumn {
  /** What the select reads: the value with its alias, when it has one. */
  select: string;
  /** What GROUP BY and ORDER BY name. */
  key: string;
  /** The value, without its alias. */
  value: string;
  /** A list read with `each`: a row without values is in no group already. */
  list: boolean;
}

/**
 * The columns of the group-by, in the form's order. A property is `properties['name']` with an
 * alias of its name that no reserved word and no other output has: the select names the alias,
 * GROUP BY and ORDER BY the value, so an alias that is also a column name never reads as one.
 */
function groupColumns(dimensions: readonly MetricDimension[]): GroupColumn[] {
  const taken = new Set([
    "bucket",
    "value",
    ...dimensions.flatMap((dimension) =>
      propertyOf(dimension) === undefined
        ? GROUP_COLUMNS[dimension as Dimension].map((column) => column.replace(/^.* as /, ""))
        : [],
    ),
  ]);
  return dimensions.flatMap((dimension): GroupColumn[] => {
    const property = propertyOf(dimension);
    if (property === undefined)
      return GROUP_COLUMNS[dimension as Dimension].map((column) => {
        const [value, alias] = column.split(" as ");
        return {
          select: column,
          key: alias ?? value,
          value,
          list: Boolean(LIST_DIMENSIONS[dimension as Dimension]),
        };
      });
    const value = `properties[${literal(property)}]`;
    const alias = propertyAlias(property, taken);
    taken.add(alias);
    return [{ select: `${value} as ${alias}`, key: value, value, list: false }];
  });
}

/**
 * An output name for a property: its name in RQL's letters, kept apart from the other outputs and
 * the reserved words. The name of a catalog column is fine: GROUP BY and ORDER BY name the value.
 */
function propertyAlias(property: string, taken: ReadonlySet<string>): string {
  const plain = property
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = /^[a-z]/.test(plain) ? plain.slice(0, 50) : `property_${plain}`.slice(0, 50);
  const reserved = (name: string) => taken.has(name) || RESERVED.has(name);
  if (!reserved(base)) return base;
  if (!reserved(`${base}_property`)) return `${base}_property`;
  let n = 2;
  while (reserved(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

/** The filter as RQL conditions on the trace columns of the table. */
function filterConditions(filter: TraceFilter, table: Exclude<Table, "prompts">): string[] {
  // The scores table copies the trace's columns: its own names for the ones a score also has.
  const column =
    table === "traces"
      ? { hasError: "has_error", cost: "cost_usd", tokens: "input_tokens + output_tokens" }
      : {
          hasError: "trace_has_error",
          cost: "trace_cost_usd",
          tokens: "trace_input_tokens + trace_output_tokens",
        };
  const parts: string[] = [];
  const anyOf = (list: string, values: readonly string[] | undefined) => {
    const kept = cleaned(values);
    if (kept.length > 0)
      parts.push(`(${kept.map((value) => `contains(${list}, ${literal(value)})`).join(" or ")})`);
  };
  const oneOf = (name: string, values: readonly string[] | undefined) => {
    const kept = cleaned(values);
    if (kept.length > 0) parts.push(`${name} in (${kept.map(literal).join(", ")})`);
  };
  anyOf("models", filter.models);
  anyOf("tools", filter.tools);
  anyOf("agents", filter.agents);
  oneOf("service_name", filter.services);
  oneOf("environment", filter.environments);
  anyOf("mcp_servers", filter.mcpServers);
  oneOf("user_id", filter.users);
  oneOf("session_id", filter.sessions);
  anyOf("tasks", filter.tasks);
  if (filter.status === "failed") parts.push(column.hasError);
  if (filter.status === "ok") parts.push(`not ${column.hasError}`);
  const minCostUsd = positive(filter.minCostUsd);
  const minTokens = positive(filter.minTokens);
  if (minCostUsd !== null) parts.push(`${column.cost} >= ${decimal(minCostUsd)}`);
  if (minTokens !== null) parts.push(`${column.tokens} >= ${decimal(minTokens)}`);
  for (const [name, values] of Object.entries(filter.properties ?? {})) {
    const kept = cleaned(values);
    if (kept.length > 0)
      parts.push(`properties[${literal(name)}] in (${kept.map(literal).join(", ")})`);
  }
  for (const name of cleaned(filter.withoutProperties))
    parts.push(`properties[${literal(name)}] is null`);
  for (const clause of filter.and ?? []) parts.push(...filterConditions(clause, table));
  return parts;
}

/**
 * A group-by of a list that the filter names keeps only the named values, as the form groups: a
 * trace of two models under a filter of one is in that model's group only.
 */
function listGroupConditions(
  dimensions: readonly MetricDimension[],
  filter: TraceFilter,
): string[] {
  const clauses = clausesOf(filter);
  return dimensions.flatMap((dimension) => {
    const list =
      propertyOf(dimension) === undefined ? LIST_DIMENSIONS[dimension as Dimension] : undefined;
    if (!list) return [];
    return clauses
      .map((clause) => cleaned(list.values(clause)))
      .filter((values) => values.length > 0)
      .map((values) => `each(${list.list}) in (${values.map(literal).join(", ")})`);
  });
}

/** Trimmed, without blanks and repeats: as the trace filter reads its values. */
function cleaned(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function positive(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}

/** A number as RQL reads it: plain digits, never an exponent (`1e-7`). */
function decimal(value: number): string {
  if (!/e/i.test(String(value))) return String(value);
  if (Math.abs(value) >= 1e21) return `${BigInt(Math.round(value))}.0`;
  return value.toFixed(20).replace(/\.?0+$/, "");
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
