import type { Aggregation, Bucket, Dimension, MeasureId } from "@/lib/contracts/query";
import { RQL_LIMITS } from "@/lib/synthesis/rql/compile";
import { clausesOf } from "@/lib/synthesis/traces/trace-filter-clauses";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import type { MetricWidget } from "@/lib/views/dashboards/types";

/**
 * The RQL text that gives the numbers of a metric widget. Pure and safe for the browser. Every
 * valid metric query has one: the text reads the same rows over the same window, and gives the
 * same numbers as the metric form (`metric-rql-parity.integration.test.ts`). A line or a bar gives
 * one row per bucket and group, a number one row, a table one row per group. The text keeps
 * every group, where the form keeps the 10 highest: the code that draws the rows keeps them
 * (`sql-chart.ts`), and fills the empty buckets.
 */

/** What a person reads under `Edit as SQL`: where the text differs from the form. */
export const EDIT_AS_SQL_NOTE =
  "The RQL text of these numbers. It does not go back to the form. The bucket size is written in the text: it does not follow the range.";

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
};

const TIME_COLUMNS: Record<Table, string> = {
  traces: "started_at",
  scores: "trace_started_at",
  prompts: "occurred_at",
};

const BUCKET_INTERVALS: Record<Bucket, string> = { hour: "1 hour", day: "1 day" };

/** The RQL text of a metric widget, read by `bucket` for a line or a bar. */
export function metricAsRql(widget: MetricWidget, bucket: Bucket): string {
  const {
    query: {
      measures: [{ measure, aggregation }],
      dimensions,
      filters: { scorer, ...filter },
    },
    chart,
  } = widget;
  const read = MEASURES[measure];
  const groups = dimensions.flatMap((dimension) => GROUP_COLUMNS[dimension]);
  const keys = groups.map((column) => column.replace(/^.* as /, ""));
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
    ...(scorer ? [`scorer_id = ${literal(scorer.id)}`] : []),
    ...dimensions
      .filter((dimension) => !LIST_DIMENSIONS[dimension])
      .flatMap((dimension) => GROUP_COLUMNS[dimension])
      .map((column) => `${column} is not null`),
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
  if (filter.status === "failed") parts.push(column.hasError);
  if (filter.status === "ok") parts.push(`not ${column.hasError}`);
  const minCostUsd = positive(filter.minCostUsd);
  const minTokens = positive(filter.minTokens);
  if (minCostUsd !== null) parts.push(`${column.cost} >= ${decimal(minCostUsd)}`);
  if (minTokens !== null) parts.push(`${column.tokens} >= ${decimal(minTokens)}`);
  for (const clause of filter.and ?? []) parts.push(...filterConditions(clause, table));
  return parts;
}

/**
 * A group-by of a list that the filter names keeps only the named values, as the form groups: a
 * trace of two models under a filter of one is in that model's group only.
 */
function listGroupConditions(dimensions: readonly Dimension[], filter: TraceFilter): string[] {
  const clauses = clausesOf(filter);
  return dimensions.flatMap((dimension) => {
    const list = LIST_DIMENSIONS[dimension];
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
