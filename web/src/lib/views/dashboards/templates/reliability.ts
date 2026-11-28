import type { DashboardTemplate } from "@/lib/views/dashboards/templates/types";
import {
  formTemplateWidget,
  rqlTemplateWidget,
  WIDE,
} from "@/lib/views/dashboards/templates/widgets";

export const RELIABILITY_TEMPLATE: DashboardTemplate = {
  id: "reliability",
  name: "Reliability",
  description:
    "Traces, errors and latency over time, the errors by model and agent, and the newest failures.",
  prompt: "Show traces, errors and latency over time, and the newest failures",
  needs: ["traces"],
  property: false,
  widgets: [
    formTemplateWidget("bar", "trace_count", "count", { title: "Traces per day", bucket: "day" }),
    formTemplateWidget("line", "error_rate", "rate", { title: "Error rate" }),
    formTemplateWidget("line", "latency", "p50", { title: "Latency p50" }),
    formTemplateWidget("line", "latency", "p95", { title: "Latency p95" }),
    rqlTemplateWidget(
      "Errors by model",
      "bar",
      "select model, count(*) as errors\nfrom events\nwhere type = 'llm_call'\n  and status = 'error'\n  and model is not null\ngroup by model\norder by errors desc\nlimit 20",
    ),
    rqlTemplateWidget(
      "Errors by agent",
      "bar",
      "select each(agents) as agent, count(*) as errors\nfrom traces\nwhere coalesce(root_error, has_error)\ngroup by agent\norder by errors desc\nlimit 20",
    ),
    rqlTemplateWidget(
      "Newest failed traces",
      "table",
      "select trace_id, started_at, duration_ms, models, agents\nfrom traces\nwhere coalesce(root_error, has_error)\norder by started_at desc\nlimit 50",
      WIDE,
    ),
  ],
};
