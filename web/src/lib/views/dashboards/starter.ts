import {
  type Aggregation,
  type MeasureId,
  type MetricQuery,
  metricQuery,
} from "@/lib/contracts/query";
import type { WidgetChart, WidgetInput } from "@/lib/views/dashboards/types";

export const STARTER_NAME = "Traces overview";

/** "Start from the traces overview": one useful set, every widget editable. */
export const STARTER_WIDGETS: readonly WidgetInput[] = [
  widget("bar", "trace_count", "count"),
  widget("line", "error_rate", "rate"),
  widget("line", "latency", "p95"),
  widget("table", "cost", "sum", ["model"]),
];

function widget(
  chart: WidgetChart,
  measure: MeasureId,
  aggregation: Aggregation,
  dimensions: MetricQuery["dimensions"] = [],
): WidgetInput {
  return {
    title: "",
    query: metricQuery(measure, aggregation, { dimensions }),
    chart,
  };
}
