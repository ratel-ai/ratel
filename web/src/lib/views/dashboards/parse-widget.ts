import { z } from "zod";
import { hasNoNul, NUL_PROBLEM } from "@/lib/contracts/json-text";
import { parseQuery } from "@/lib/contracts/query";
import { type MetricFeatures, metricOffered } from "@/lib/synthesis/metrics/catalog";
import {
  MAX_WIDGET_TITLE,
  SQL_WIDGET_PROBLEM,
  WIDGET_CHARTS,
  type WidgetInput,
} from "@/lib/views/dashboards/types";
import { chartProblem, queryMetric } from "@/lib/views/dashboards/widget";

const widgetShape = z.strictObject({
  title: z.string().trim().max(MAX_WIDGET_TITLE).refine(hasNoNul, NUL_PROBLEM).default(""),
  query: z.unknown(),
  chart: z.enum(WIDGET_CHARTS),
});

export type ParsedWidget = { ok: true; widget: WidgetInput } | { ok: false; error: string };

/** A widget from outside: its shape, its query's contract, the project's switches (all off unless given), then the chart's rules. */
export function parseWidget(
  raw: unknown,
  features: MetricFeatures = { customMonitoring: false },
): ParsedWidget {
  const parsed = widgetShape.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      error:
        parsed.error.issues.find(({ message }) => message === NUL_PROBLEM)?.message ??
        "The widget settings are invalid.",
    };
  const query = parseOfferedQuery(parsed.data.query, features);
  if (!query.ok) return query;
  if (query.query.kind === "sql") return { ok: false, error: SQL_WIDGET_PROBLEM };
  const widget: WidgetInput = { ...parsed.data, query: query.query };
  const problem = chartProblem(widget);
  return problem ? { ok: false, error: problem } : { ok: true, widget };
}

/** A query the contract allows and the project's switches offer. */
export function parseOfferedQuery(raw: unknown, features: MetricFeatures) {
  const parsed = parseQuery(raw);
  if (!parsed.ok) return parsed;
  const metric = queryMetric(parsed.query);
  if (metric && !metricOffered(metric, features))
    return { ok: false as const, error: `${metric.label} is off for this project.` };
  return parsed;
}
