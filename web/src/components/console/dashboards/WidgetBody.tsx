"use client";

import { DataTable } from "@ratel/design-system/data-table";
import { StatRow } from "@ratel/design-system/stat-row";
import { EmptyState } from "@ratel/design-system/states";
import { ChartColumn, CircleAlert } from "lucide-react";
import Link from "next/link";
import { getMetric } from "@/lib/synthesis/metrics/catalog";
import type { MetricResult } from "@/lib/synthesis/metrics/query";
import { formatInteger } from "@/lib/synthesis/traces/v2/format";
import {
  chartModel,
  formatMetric,
  formatMetricExact,
  isEmptyResult,
} from "@/lib/views/dashboards/chart-model";
import { type DashboardRange, widgetTracesHref } from "@/lib/views/dashboards/links";
import type { WidgetInput } from "@/lib/views/dashboards/types";
import { aggregationLabel, groupByLabel, widgetName } from "@/lib/views/dashboards/widget";
import { MetricChart } from "./MetricChart";

/** A widget's numbers in its chart type, or why there are none. */
export function WidgetBody({
  projectId,
  widget,
  result,
  range,
}: {
  projectId: string;
  widget: WidgetInput;
  result: MetricResult | null;
  range: DashboardRange;
}) {
  const metric = getMetric(widget.metric);
  if (!result || !metric)
    return (
      <EmptyState
        icon={CircleAlert}
        title="The numbers could not be read"
        description="Reload the page to try again."
      />
    );
  if (isEmptyResult(result))
    return (
      <EmptyState
        icon={ChartColumn}
        title="No data in this time range"
        description="Try a longer range or fewer filters."
      />
    );
  const { unit } = metric;
  if (widget.chart === "number") {
    const [{ total, samples }] = result.series;
    const noun = metric.source === "traces" ? "trace" : "captured prompt";
    return (
      <StatRow
        className="grid-cols-1 rounded-none border-0 lg:grid-cols-1 [&>*]:p-0"
        stats={[
          {
            label: aggregationLabel(widget.aggregation),
            value: formatMetric(total, unit),
            hint: `${formatInteger(samples)} ${noun}${samples === 1 ? "" : "s"}`,
          },
        ]}
      />
    );
  }
  if (widget.chart === "table" && widget.groupBy) {
    const by = widget.groupBy;
    return (
      <DataTable
        caption={widgetName(widget)}
        density="compact"
        rows={result.series}
        rowKey={(row) => row.group ?? ""}
        columns={[
          {
            id: "group",
            header: groupByLabel(by),
            className: "max-w-0 truncate",
            cell: (row) => (
              <Link
                href={widgetTracesHref(projectId, widget.filter, range, {
                  by,
                  value: row.group ?? "",
                })}
                className="text-fg hover:underline"
                title={row.group ?? undefined}
              >
                {row.group}
              </Link>
            ),
          },
          ...(widget.metric === "trace_count"
            ? []
            : [
                {
                  id: "traces",
                  header: "Traces",
                  align: "right" as const,
                  width: "6rem",
                  cell: (row: MetricResult["series"][number]) => formatInteger(row.samples),
                },
              ]),
          {
            id: "value",
            header:
              widget.aggregation === "avg" || widget.aggregation.startsWith("p")
                ? aggregationLabel(widget.aggregation)
                : metric.label,
            align: "right",
            width: "8rem",
            cell: (row) => formatMetricExact(row.total, unit),
          },
        ]}
      />
    );
  }
  const chart = widget.chart === "bar" ? "bar" : "line";
  return (
    <MetricChart
      chart={chart}
      model={chartModel(result, widget.aggregation, unit, chart)}
      result={result}
      unit={unit}
      label={widgetName(widget)}
    />
  );
}
