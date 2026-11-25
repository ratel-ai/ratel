import { sql } from "drizzle-orm";
import { type MetricSourceQuery, metricSeams, SUMMARY_GROUPS } from "@/lib/synthesis/metrics/query";
import { runFunnel } from "./funnel";

/**
 * The stored results as a source of the metric catalog: one row per scorer and trace. A trace
 * whose summary is gone keeps its results; it is only in no property's group and under no filter.
 * Import this module for its effect wherever `runQuery` may read a scorer metric.
 */
export const scorerMetricSource: MetricSourceQuery = {
  table: sql`trace_scores r
    join trace_scorers c on c.id = r.scorer_id and c.project_id = r.project_id
    left join otel_trace_summaries s on s.project_id = r.project_id and s.trace_id = r.trace_id`,
  project: sql`r.project_id`,
  time: sql`r.trace_started_at`,
  knownAt: sql`r.scored_at`,
  scorer: sql`r.scorer_id`,
  measures: {
    scorer_pass_rate: {
      value: sql`case when r.passed then 1 else 0 end`,
      where: sql`r.passed is not null`,
    },
    scorer_average: { value: sql`r.value`, where: sql`r.passed is null` },
    scorer_count: { value: sql`1` },
  },
  groups: {
    ...SUMMARY_GROUPS,
    scorer: { column: sql`r.scorer_id::text`, array: false, label: sql`c.name` },
  },
};

metricSeams.scores = scorerMetricSource;
metricSeams.funnel = runFunnel;
