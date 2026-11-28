import { z } from "zod";
import { hasNoNul, NUL_PROBLEM } from "@/lib/contracts/json-text";
import { MAX_SQL_TEXT, parseQuery, type Query } from "@/lib/contracts/query";
import { isFormText } from "@/lib/views/dashboards/metric-rql";
import {
  MAX_WIDGET_TITLE,
  type MetricChartKind,
  STORED_CHARTS,
  type WidgetChart,
  type WidgetInput,
} from "@/lib/views/dashboards/types";
import {
  chartProblem,
  fitWidget,
  formOf,
  formWidget,
  isMetricChart,
} from "@/lib/views/dashboards/widget";

const widgetShape = z.strictObject({
  title: z.string().trim().max(MAX_WIDGET_TITLE).refine(hasNoNul, NUL_PROBLEM).default(""),
  query: z.unknown(),
  chart: z.enum(STORED_CHARTS),
});

export type ParsedWidget = { ok: true; widget: WidgetInput } | { ok: false; error: string };

/** How a widget is read: the chart of an older widget of kind sql. */
export interface ParseWidgetOptions {
  /**
   * The chart of an older RQL widget, drawn as "a table, or a line when its rows have one time
   * column": from its compiled columns on the server (`sqlChartOfText`). A table by default.
   */
  sqlChart?: (text: string) => MetricChartKind;
}

/**
 * A widget from outside: its shape, its query's contract, then the chart's rules. A widget an older version stored is read in today's shape: a
 * metric is RQL with the form's selection, and the chart `sql` is the chart its rows drew. A
 * selection whose text is not its own any more is dropped: the text is Custom.
 */
export function parseWidget(
  raw: unknown,
  { sqlChart = () => "table" }: ParseWidgetOptions = {},
): ParsedWidget {
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
  const widget = currentWidget(parsed.data.title, query.query, parsed.data.chart, sqlChart);
  if (!widget.ok) return widget;
  const problem = chartProblem(widget.widget);
  return problem ? { ok: false, error: problem } : widget;
}

/** A widget in today's shape. */
function currentWidget(
  title: string,
  query: Query,
  chart: (typeof STORED_CHARTS)[number],
  sqlChart: (text: string) => MetricChartKind,
): ParsedWidget {
  if (query.kind === "metric") {
    if (!isMetricChart(chart as WidgetChart))
      return { ok: false, error: `A metric cannot be drawn as a ${chart}.` };
    if (chart === "number" && query.dimensions.length > 0)
      return { ok: false, error: "A number cannot be grouped." };
    const widget = { ...formWidget(formOf(query), chart as MetricChartKind), title };
    // A long filter can give a text over the limit: refused, so a stored one stays as it was.
    const length = widget.query.kind === "sql" ? widget.query.text.length : 0;
    if (length > MAX_SQL_TEXT)
      return {
        ok: false,
        error: `The filter of this metric gives an RQL text of ${length.toLocaleString("en-US")} characters, and RQL takes at most ${MAX_SQL_TEXT.toLocaleString("en-US")} characters. Narrow the filter.`,
      };
    return { ok: true, widget };
  }
  if (query.kind !== "sql")
    return { ok: true, widget: { title, query, chart: chart as WidgetChart } };
  const drawn = chart === "sql" ? sqlChart(query.text) : (chart as WidgetChart);
  if (!isMetricChart(drawn)) return { ok: false, error: `A metric cannot be drawn as a ${drawn}.` };
  const { form, ...text } = query;
  const own = form && isFormText(query, drawn);
  const widget = { title, query: own ? query : text, chart: drawn };
  // The rules first: the editor's fit would drop a number's group-by without a word.
  const problem = chartProblem(widget);
  return problem ? { ok: false, error: problem } : { ok: true, widget: fitWidget(widget) };
}
