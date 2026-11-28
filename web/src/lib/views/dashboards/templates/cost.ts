import type { DashboardTemplate } from "@/lib/views/dashboards/templates/types";
import {
  formTemplateWidget,
  rqlTemplateWidget,
  SMALL,
  WIDE,
} from "@/lib/views/dashboards/templates/widgets";

export const COST_TEMPLATE: DashboardTemplate = {
  id: "cost",
  name: "Cost",
  description:
    "What the traces cost per day, by model, provider and agent, and the costliest traces.",
  prompt: "Show cost per day by model, provider and agent, and the costliest traces",
  needs: ["traces"],
  property: false,
  widgets: [
    formTemplateWidget("bar", "cost", "sum", { title: "Cost per day", bucket: "day" }),
    formTemplateWidget("line", "cost", "sum", {
      title: "Cost per day by model",
      dimensions: ["model"],
      bucket: "day",
    }),
    rqlTemplateWidget(
      "Cost by provider",
      "bar",
      "select provider, coalesce(sum(cost_usd), 0) as cost_usd\nfrom events\nwhere provider is not null\ngroup by provider\norder by cost_usd desc\nlimit 20",
    ),
    formTemplateWidget("table", "cost", "sum", { title: "Cost by agent", dimensions: ["agent"] }),
    formTemplateWidget("number", "cost", "avg", { title: "Cost per trace", size: SMALL }),
    rqlTemplateWidget(
      "Input tokens per day",
      "line",
      "select time_bucket('1 day', started_at) as day, coalesce(sum(input_tokens), 0) as input_tokens\nfrom traces\ngroup by day\norder by day desc",
    ),
    rqlTemplateWidget(
      "Output tokens per day",
      "line",
      "select time_bucket('1 day', started_at) as day, coalesce(sum(output_tokens), 0) as output_tokens\nfrom traces\ngroup by day\norder by day desc",
    ),
    rqlTemplateWidget(
      "Most expensive traces",
      "table",
      "select trace_id, started_at, cost_usd, models, duration_ms\nfrom traces\nwhere cost_usd is not null\norder by cost_usd desc\nlimit 20",
      WIDE,
    ),
  ],
};
