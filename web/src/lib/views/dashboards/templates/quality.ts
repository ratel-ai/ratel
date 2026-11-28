import type { DashboardTemplate } from "@/lib/views/dashboards/templates/types";
import {
  formTemplateWidget,
  rqlTemplateWidget,
  WIDE,
} from "@/lib/views/dashboards/templates/widgets";

export const QUALITY_TEMPLATE: DashboardTemplate = {
  id: "quality",
  name: "Quality",
  description:
    "The results of each scorer over time, their pass rates, and the lowest-scoring traces.",
  prompt: "Show the pass rate of each scorer over time and the traces that score lowest",
  needs: ["scores"],
  property: false,
  widgets: [
    formTemplateWidget("line", "scorer_average", "avg", {
      title: "Score per scorer",
      dimensions: ["scorer"],
      bucket: "day",
    }),
    formTemplateWidget("line", "scorer_pass_rate", "rate", {
      title: "Pass rate per scorer",
      dimensions: ["scorer"],
      bucket: "day",
    }),
    formTemplateWidget("table", "scorer_pass_rate", "rate", {
      title: "Pass rate by scorer",
      dimensions: ["scorer"],
    }),
    formTemplateWidget("bar", "scorer_count", "count", { title: "Results per day", bucket: "day" }),
    rqlTemplateWidget(
      "Lowest-scoring traces",
      "table",
      "select trace_id, scorer, value, passed, scored_at\nfrom scores\nwhere value is not null\norder by value asc\nlimit 20",
      WIDE,
    ),
  ],
};
