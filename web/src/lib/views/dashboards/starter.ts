import type { WidgetInput } from "@/lib/views/dashboards/types";

export const STARTER_NAME = "Traces overview";

/** "Start from the traces overview": one useful set, every widget editable. */
export const STARTER_WIDGETS: readonly WidgetInput[] = [
  widget({ metric: "trace_count", aggregation: "count", chart: "bar" }),
  widget({ metric: "error_rate", aggregation: "rate", chart: "line" }),
  widget({ metric: "latency", aggregation: "p95", chart: "line" }),
  widget({ metric: "cost", aggregation: "sum", groupBy: "model", chart: "table" }),
];

function widget(
  fields: Pick<WidgetInput, "metric" | "aggregation" | "chart"> & Partial<WidgetInput>,
): WidgetInput {
  return { title: "", groupBy: null, filter: {}, width: "half", ...fields };
}
