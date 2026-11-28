import type { DashboardTemplate } from "@/lib/views/dashboards/templates/types";
import { formTemplateWidget, rqlTemplateWidget } from "@/lib/views/dashboards/templates/widgets";

/** One context measure of `prompts` per day. */
function perDay(title: string, column: string) {
  return rqlTemplateWidget(
    title,
    "bar",
    `select time_bucket('1 day', occurred_at) as day, coalesce(sum(${column}), 0) as ${column}\nfrom prompts\ngroup by day\norder by day desc`,
  );
}

export const CONTEXT_USE_TEMPLATE: DashboardTemplate = {
  id: "context-use",
  name: "Context use",
  description:
    "What fills the prompts: context, tools, skills, history and memory tokens, and their cost.",
  prompt: "Show what fills my agents' context: tools, skills, history and memory tokens",
  needs: ["prompts"],
  property: false,
  widgets: [
    formTemplateWidget("line", "context_tokens", "sum", { title: "Context tokens per day" }),
    formTemplateWidget("line", "context_cost", "sum", { title: "Context cost per day" }),
    perDay("Tool definition tokens per day", "tools_tokens"),
    perDay("Skill tokens per day", "skills_tokens"),
    perDay("History tokens per day", "history_tokens"),
    perDay("Memory tokens per day", "memory_tokens"),
  ],
};
