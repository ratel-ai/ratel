import type { DashboardTemplate } from "@/lib/views/dashboards/templates/types";
import { formTemplateWidget } from "@/lib/views/dashboards/templates/widgets";

/** "Start from the traces overview": one useful set, every widget editable. */
export const TRACES_OVERVIEW_WIDGETS = [
  formTemplateWidget("bar", "trace_count", "count"),
  formTemplateWidget("line", "error_rate", "rate"),
  formTemplateWidget("line", "latency", "p95"),
  formTemplateWidget("table", "cost", "sum", { dimensions: ["model"] }),
] as const;

export const TRACES_OVERVIEW_TEMPLATE: DashboardTemplate = {
  id: "traces-overview",
  name: "Traces overview",
  description: "Traces, error rate, p95 latency and cost by model: the first view of a project.",
  prompt: "Show how many traces my agents run, their errors, latency and cost",
  needs: ["traces"],
  property: false,
  widgets: TRACES_OVERVIEW_WIDGETS,
};
