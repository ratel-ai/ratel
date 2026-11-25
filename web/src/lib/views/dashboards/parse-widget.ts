import { z } from "zod";
import { hasNoNul, NUL_PROBLEM } from "@/lib/contracts/json-text";
import { parseQuery } from "@/lib/contracts/query";
import { MAX_WIDGET_TITLE, WIDGET_CHARTS, type WidgetInput } from "@/lib/views/dashboards/types";
import { chartProblem } from "@/lib/views/dashboards/widget";

const widgetShape = z.strictObject({
  title: z.string().trim().max(MAX_WIDGET_TITLE).refine(hasNoNul, NUL_PROBLEM).default(""),
  query: z.unknown(),
  chart: z.enum(WIDGET_CHARTS),
});

export type ParsedWidget = { ok: true; widget: WidgetInput } | { ok: false; error: string };

/** A widget from outside: its shape, its query's contract, then the chart's rules. */
export function parseWidget(raw: unknown): ParsedWidget {
  const parsed = widgetShape.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      error:
        parsed.error.issues.find(({ message }) => message === NUL_PROBLEM)?.message ??
        "The widget settings are invalid.",
    };
  const query = parseQuery(parsed.data.query);
  if (!query.ok) return query;
  const widget: WidgetInput = { ...parsed.data, query: query.query };
  const problem = chartProblem(widget);
  return problem ? { ok: false, error: problem } : { ok: true, widget };
}
