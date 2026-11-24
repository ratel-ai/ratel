import { z } from "zod";
import {
  getMetric,
  METRIC_AGGREGATIONS,
  METRIC_GROUP_BYS,
  METRIC_IDS,
  type MetricFeatures,
  metricOffered,
  metricSelectionProblem,
} from "@/lib/synthesis/metrics/catalog";
import {
  MAX_WIDGET_TITLE,
  WIDGET_CHARTS,
  WIDGET_WIDTHS,
  type WidgetInput,
} from "@/lib/views/dashboards/types";
import { chartProblem } from "@/lib/views/dashboards/widget";

const values = z.array(z.string().trim().min(1).max(500)).max(50);
const threshold = z.number().finite().nonnegative();
const filterShape = z
  .object({
    models: values,
    tools: values,
    services: values,
    environments: values,
    agents: values,
    mcpServers: values,
    status: z.enum(["failed", "ok"]),
    minCostUsd: threshold,
    minTokens: threshold,
  })
  .partial()
  .strict();

const widgetShape = z
  .object({
    title: z.string().trim().max(MAX_WIDGET_TITLE).default(""),
    metric: z.enum(METRIC_IDS),
    aggregation: z.enum(METRIC_AGGREGATIONS),
    groupBy: z.enum(METRIC_GROUP_BYS).nullable().default(null),
    filter: filterShape.default({}),
    scorerId: z.string().optional(),
    chart: z.enum(WIDGET_CHARTS),
    width: z.enum(WIDGET_WIDTHS),
  })
  .strict();

export type ParsedWidget = { ok: true; widget: WidgetInput } | { ok: false; error: string };

/** A widget from outside: its shape, the project's switches (all off unless given), then the metric catalog's and the chart's rules. */
export function parseWidget(
  raw: unknown,
  features: MetricFeatures = { scorers: false },
): ParsedWidget {
  const id = (raw as { metric?: unknown } | null)?.metric;
  if (typeof id === "string") {
    const metric = getMetric(id);
    if (!metric) return { ok: false, error: `Unknown metric "${id}".` };
    if (!metricOffered(metric, features))
      return { ok: false, error: `${metric.label} is off for this project.` };
  }
  const parsed = widgetShape.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "The widget settings are invalid." };
  const widget: WidgetInput = parsed.data;
  const problem = metricSelectionProblem(widget) ?? chartProblem(widget);
  return problem ? { ok: false, error: problem } : { ok: true, widget };
}
