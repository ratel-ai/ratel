import type { DashboardTemplate } from "@/lib/views/dashboards/templates/types";
import { formTemplateWidget, rqlTemplateWidget } from "@/lib/views/dashboards/templates/widgets";

const MODEL_CALLS = "from events\nwhere type = 'llm_call'\n  and model is not null";

export const MODELS_TEMPLATE: DashboardTemplate = {
  id: "models",
  name: "Models compared",
  description: "Latency, error rate, cost and tokens of each model the agents call.",
  prompt: "Compare the models my agents call: latency, errors, cost and tokens",
  needs: ["traces"],
  property: false,
  widgets: [
    rqlTemplateWidget(
      "Calls by model",
      "bar",
      `select model, count(*) as calls\n${MODEL_CALLS}\ngroup by model\norder by calls desc\nlimit 20`,
    ),
    rqlTemplateWidget(
      "Latency p95 by model",
      "bar",
      `select model, p95(duration_ms) as p95_ms\n${MODEL_CALLS}\ngroup by model\norder by p95_ms desc\nlimit 20`,
    ),
    rqlTemplateWidget(
      "Error rate by model",
      "bar",
      `select model, rate(status = 'error') as error_rate\n${MODEL_CALLS}\ngroup by model\norder by error_rate desc\nlimit 20`,
    ),
    formTemplateWidget("line", "cost", "sum", {
      title: "Cost per day by model",
      dimensions: ["model"],
      bucket: "day",
    }),
    rqlTemplateWidget(
      "Tokens by model",
      "bar",
      `select model, coalesce(sum(input_tokens + output_tokens), 0) as tokens\n${MODEL_CALLS}\ngroup by model\norder by tokens desc\nlimit 20`,
    ),
  ],
};
