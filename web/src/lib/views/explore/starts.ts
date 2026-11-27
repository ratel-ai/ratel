import {
  flowQuery,
  geographyQuery,
  type MetricQuery,
  metricQuery,
  stepFlowQuery,
} from "@/lib/contracts/query";
import type { WidgetChart, WidgetInput, WidgetQuery } from "@/lib/views/dashboards/types";
import { widgetOfKind } from "@/lib/views/dashboards/widget";

/** What the page opens with, so it is never empty. */
export const START_PANEL: WidgetInput = panel(
  metricQuery("trace_count", "count", { bucket: "day" }),
  "bar",
);

/** What fills a panel in one step. */
export const STARTING_POINTS: readonly { label: string; panel: WidgetInput }[] = [
  { label: "Traces by day", panel: START_PANEL },
  {
    label: "Errors by model",
    panel: panel(metricQuery("error_rate", "rate", { dimensions: ["model"] }), "line"),
  },
  {
    label: "Cost by agent",
    panel: panel(metricQuery("cost", "sum", { dimensions: ["agent"] }), "bar"),
  },
  { label: "Tool flow", panel: panel(flowQuery("tool"), "flow") },
  { label: "Step flow", panel: panel(stepFlowQuery("tool"), "step_flow") },
  { label: "Funnel", panel: widgetOfKind("funnel", START_PANEL) },
  {
    label: "Traces by country",
    panel: panel(geographyQuery("trace_count", "count"), "geography"),
  },
];

/** The start panel for the traces of a filter. */
export function startPanel(filters: MetricQuery["filters"]): WidgetInput {
  return { ...START_PANEL, query: { ...START_PANEL.query, filters } as WidgetQuery };
}

function panel(query: WidgetQuery, chart: WidgetChart): WidgetInput {
  return { title: "", query, chart };
}
