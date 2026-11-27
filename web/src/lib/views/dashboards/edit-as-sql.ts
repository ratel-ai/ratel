import type { Aggregation, Bucket, Dimension, MeasureId } from "@/lib/contracts/query";
import { RQL_LIMITS } from "@/lib/synthesis/rql/compile";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import type { MetricWidget } from "@/lib/views/dashboards/types";

/**
 * `Edit as SQL`: the RQL text that gives the numbers of a metric widget. Pure and safe for the
 * browser. The text reads the same rows over the same window: a line or a bar gives one row per
 * bucket and group, a number one row, a table one row per group. It keeps every group, where the
 * form keeps the 10 highest. RQL has no CASE and no unnest, so a rate, a context metric and a
 * group-by on a list (model, tool, agent) have no RQL form yet: those give the reason instead.
 */

export type MetricRql = { ok: true; text: string } | { ok: false; reason: string };

type Table = "traces" | "scores";

/** What each measure reads, per aggregation. */
const MEASURES: Partial<Record<MeasureId, { table: Table; value: string; where?: string }>> = {
  trace_count: { table: "traces", value: "*" },
  latency: { table: "traces", value: "duration_ms" },
  tokens: { table: "traces", value: "input_tokens + output_tokens" },
  cost: { table: "traces", value: "cost_usd" },
  scorer_average: { table: "scores", value: "value", where: "passed is null" },
  scorer_count: { table: "scores", value: "*" },
};

const AGGREGATES: Record<Aggregation, ((value: string) => string) | null> = {
  count: (value) => `count(${value})`,
  sum: (value) => `sum(${value})`,
  avg: (value) => `avg(${value})`,
  p50: (value) => `p50(${value})`,
  p95: (value) => `p95(${value})`,
  // A rate is an average of a condition: RQL has no CASE to turn one into a number.
  rate: null,
};

/** The column of each dimension RQL can group by: one value per row. */
const GROUP_COLUMNS: Partial<Record<Dimension, readonly string[]>> = {
  service: ["service_name"],
  environment: ["environment"],
  scorer: ["scorer_id", "scorer"],
};

const BUCKET_INTERVALS: Record<Bucket, string> = { hour: "1 hour", day: "1 day" };

export function metricAsRql(widget: MetricWidget, bucket: Bucket): MetricRql {
  const {
    query: {
      measures: [{ measure, aggregation }],
      dimensions,
      filters: { scorer, ...filter },
    },
    chart,
  } = widget;
  const read = MEASURES[measure];
  const aggregate = AGGREGATES[aggregation];
  if (!read || !aggregate)
    return { ok: false, reason: "This metric has no RQL form yet: RQL cannot compute a rate." };
  const groups: string[] = [];
  for (const dimension of dimensions) {
    const columns = GROUP_COLUMNS[dimension];
    if (!columns)
      return {
        ok: false,
        reason: `A group-by ${dimension} has no RQL form yet: RQL cannot split a list of values.`,
      };
    groups.push(...columns);
  }
  const conditions = filterConditions(filter, read.table);
  if (conditions === null)
    return { ok: false, reason: "This filter has no RQL form on scorer results." };
  const timed = chart === "line" || chart === "bar";
  const time = read.table === "traces" ? "started_at" : "trace_started_at";
  const selected = [
    ...(timed ? [`time_bucket('${BUCKET_INTERVALS[bucket]}', ${time}) as bucket`] : []),
    ...groups,
    `${aggregate(read.value)} as value`,
  ];
  const where = [
    ...(read.where ? [read.where] : []),
    ...(scorer ? [`scorer_id = ${literal(scorer.id)}`] : []),
    ...groups.map((column) => `${column} is not null`),
    ...conditions,
  ];
  const grouped = [...(timed ? ["bucket"] : []), ...groups];
  const ordered = timed ? ["bucket", ...groups] : groups.length > 0 ? ["value desc"] : [];
  return {
    ok: true,
    text: [
      `select ${selected.join(", ")}`,
      `from ${read.table}`,
      ...(where.length > 0 ? [`where ${where.join("\n  and ")}`] : []),
      ...(grouped.length > 0 ? [`group by ${grouped.join(", ")}`] : []),
      ...(ordered.length > 0 ? [`order by ${ordered.join(", ")}`] : []),
      ...(grouped.length > 0 ? [`limit ${RQL_LIMITS.maxLimit}`] : []),
    ].join("\n"),
  };
}

/** The filter as RQL conditions, or null for a part the table has no column for. */
function filterConditions(filter: TraceFilter, table: Table): string[] | null {
  const traces = table === "traces";
  const parts: string[] = [];
  const anyOf = (list: string, values: readonly string[] | undefined) => {
    const kept = cleaned(values);
    if (kept.length > 0)
      parts.push(`(${kept.map((value) => `contains(${list}, ${literal(value)})`).join(" or ")})`);
  };
  const oneOf = (column: string, values: readonly string[] | undefined) => {
    const kept = cleaned(values);
    if (kept.length > 0) parts.push(`${column} in (${kept.map(literal).join(", ")})`);
  };
  anyOf("models", filter.models);
  anyOf("tools", filter.tools);
  anyOf("agents", filter.agents);
  oneOf("service_name", filter.services);
  oneOf("environment", filter.environments);
  const minCostUsd = positive(filter.minCostUsd);
  const minTokens = positive(filter.minTokens);
  // The scores table has no column for these: they are properties of the trace.
  const onTraces =
    cleaned(filter.mcpServers).length > 0 ||
    filter.status !== undefined ||
    minCostUsd !== null ||
    minTokens !== null;
  if (onTraces && !traces) return null;
  anyOf("mcp_servers", filter.mcpServers);
  if (filter.status === "failed") parts.push("has_error");
  if (filter.status === "ok") parts.push("not has_error");
  if (minCostUsd !== null) parts.push(`cost_usd >= ${minCostUsd}`);
  if (minTokens !== null) parts.push(`input_tokens + output_tokens >= ${minTokens}`);
  for (const clause of filter.and ?? []) {
    const more = filterConditions(clause, table);
    if (more === null) return null;
    parts.push(...more);
  }
  return parts;
}

/** Trimmed, without blanks and repeats: as the trace filter reads its values. */
function cleaned(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function positive(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
