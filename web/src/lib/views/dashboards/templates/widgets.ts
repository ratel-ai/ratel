import {
  type Aggregation,
  type Bucket,
  type MeasureId,
  type MetricQuery,
  metricQuery,
} from "@/lib/contracts/query";
import type { TemplateWidget } from "@/lib/views/dashboards/templates/types";
import type { GridPosition, MetricChartKind } from "@/lib/views/dashboards/types";
import { formOf, formWidget, sqlWidgetQuery } from "@/lib/views/dashboards/widget";

/** How the templates write their widgets. Pure. */

/** A whole row: for a table of rows. */
export const WIDE = { w: 12, h: 7 } as const;
/** A third of a row: for a number. */
export const SMALL = { w: 4, h: 4 } as const;

interface FormOptions {
  title?: string;
  dimensions?: MetricQuery["dimensions"];
  bucket?: Bucket;
  size?: Pick<GridPosition, "w" | "h">;
}

/** A widget of the metric form: it opens with its dropdowns. */
export function formTemplateWidget(
  chart: MetricChartKind,
  measure: MeasureId,
  aggregation: Aggregation,
  { title = "", dimensions = [], bucket, size }: FormOptions = {},
): TemplateWidget {
  const widget = formWidget(
    formOf(metricQuery(measure, aggregation, { dimensions, ...(bucket ? { bucket } : {}) })),
    chart,
  );
  return { ...widget, title, ...(size ? { size } : {}) };
}

/** A widget of RQL text, for what the form cannot write. */
export function rqlTemplateWidget(
  title: string,
  chart: MetricChartKind,
  text: string,
  size?: Pick<GridPosition, "w" | "h">,
): TemplateWidget {
  return { title, query: sqlWidgetQuery(text), chart, ...(size ? { size } : {}) };
}
