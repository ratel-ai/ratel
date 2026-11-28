import type { DashboardTemplate } from "@/lib/views/dashboards/templates/types";
import { formTemplateWidget, rqlTemplateWidget } from "@/lib/views/dashboards/templates/widgets";

export const AGENTS_TEMPLATE: DashboardTemplate = {
  id: "agents",
  name: "Agents",
  description: "Runs, cost and errors of each agent, and which agent hands off to which.",
  prompt: "Show the runs, cost and errors of each agent and their hand-offs",
  needs: ["agents"],
  property: false,
  widgets: [
    formTemplateWidget("line", "trace_count", "count", {
      title: "Runs per agent",
      dimensions: ["agent"],
      bucket: "day",
    }),
    formTemplateWidget("table", "cost", "sum", { title: "Cost per agent", dimensions: ["agent"] }),
    formTemplateWidget("table", "error_rate", "rate", {
      title: "Error rate per agent",
      dimensions: ["agent"],
    }),
    formTemplateWidget("table", "latency", "p95", {
      title: "Latency p95 per agent",
      dimensions: ["agent"],
    }),
    rqlTemplateWidget(
      "Hand-offs",
      "table",
      "select caller_agent, agent, count(*) as hand_offs\nfrom events\nwhere caller_agent is not null\n  and agent is not null\ngroup by caller_agent, agent\norder by hand_offs desc\nlimit 50",
    ),
  ],
};
