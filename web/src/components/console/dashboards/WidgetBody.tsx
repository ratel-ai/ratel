"use client";

import { DataTable } from "@ratel/design-system/data-table";
import { StatRow } from "@ratel/design-system/stat-row";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { ChartColumn, CircleAlert, Funnel, Waypoints } from "lucide-react";
import Link from "next/link";
import { StillCalculating } from "@/components/console/scorers/StillCalculating";
import type { MetricQuery } from "@/lib/contracts/query";
import { getMetric, type MetricSource } from "@/lib/synthesis/metrics/catalog";
import type { MetricResult, QueryResult } from "@/lib/synthesis/metrics/query";
import { withClause } from "@/lib/synthesis/traces/trace-filter-clauses";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import { formatInteger } from "@/lib/synthesis/traces/v2/format";
import {
  chartModel,
  formatMetric,
  formatMetricExact,
  isEmptyResult,
  seriesKey,
} from "@/lib/views/dashboards/chart-model";
import type { DashboardClusters } from "@/lib/views/dashboards/clusters";
import {
  type DashboardRange,
  funnelStepFilter,
  stepFlowFilter,
  widgetTracesHref,
} from "@/lib/views/dashboards/links";
import type { DashboardFilters, WidgetInput, WidgetResult } from "@/lib/views/dashboards/types";
import {
  aggregationLabel,
  dimensionLabel,
  flowNodeNoun,
  queryFilter,
  widgetName,
} from "@/lib/views/dashboards/widget";
import { scorerHref } from "@/lib/views/scorers/paths";
import { ClustersBody } from "./ClustersBody";
import { FlowChart } from "./FlowChart";
import { FunnelChart } from "./FunnelChart";
import { GeographyChart } from "./GeographyChart";
import { MetricChart } from "./MetricChart";
import { SqlBody } from "./SqlBody";
import { StepFlowChart } from "./StepFlowChart";

const SAMPLE_NOUN: Readonly<Record<MetricSource, string>> = {
  traces: "trace",
  context: "captured prompt",
  scores: "result",
};

/** A widget's numbers in its chart type, or why there are none. */
export function WidgetBody({
  projectId,
  widget,
  result,
  range,
  filters: dashboardFilters,
  available = true,
  missingScorer,
  fill = false,
}: {
  projectId: string;
  widget: WidgetInput;
  result: WidgetResult | null;
  range: DashboardRange;
  /** The dashboard's, for the links to what a widget shows. */
  filters: DashboardFilters;
  /** False while the switch of the metric, or of RQL for kind sql, is off. */
  available?: boolean;
  /** The scorer of an imported widget, when the project does not have it. */
  missingScorer?: string;
  /** The chart takes the height of the place it is in. */
  fill?: boolean;
}) {
  const { query } = widget;
  if (!available && query.kind === "sql")
    return (
      <EmptyState
        icon={CircleAlert}
        title="SQL widgets are off for this project"
        description="The widget keeps its RQL text, and shows its rows again when RQL is on."
      />
    );
  if (!available)
    return (
      <EmptyState
        icon={CircleAlert}
        title="Scorers are off for this project"
        description="The widget shows its numbers again when they are on."
      />
    );
  if (missingScorer)
    return (
      <EmptyState
        icon={CircleAlert}
        title={`No scorer named "${missingScorer}"`}
        description="This project does not have the scorer. Create it and edit the widget, or pick another."
      />
    );
  if (!result)
    return (
      <EmptyState
        icon={CircleAlert}
        title="The numbers could not be read"
        description="Reload the page to try again."
      />
    );
  if (result.kind === "refused")
    return (
      <Callout tone="danger" title="RQL refused the query">
        {result.message} Fix: {result.fix}
      </Callout>
    );
  if (query.kind === "sql" && result.kind === "sql")
    return <SqlBody result={result} label={widgetName(widget)} fill={fill} />;
  if (query.kind === "metric" && result.kind === "metric")
    return (
      <MetricBody
        projectId={projectId}
        query={query}
        widget={widget}
        result={result}
        range={range}
        filters={dashboardFilters}
        fill={fill}
      />
    );
  if (query.kind === "flow" && result.kind === "flow")
    return result.edges.length === 0 ? (
      <EmptyState
        icon={Waypoints}
        title="No moves in this time range"
        description={
          result.sample.matched === 0
            ? "No trace matches. Try a longer range or fewer filters."
            : `No trace goes from one ${flowNodeNoun(query.node)} to another${query.start || query.end ? " between the start and the end" : ""}.`
        }
      />
    ) : (
      <FlowChart
        result={result}
        label={widgetName(widget)}
        noun={`${flowNodeNoun(query.node)}s`}
        fill={fill}
        edgeHref={({ source }) =>
          widgetTracesHref(
            projectId,
            withClause<TraceFilter>(query.filters, dashboardFilters),
            range,
            // The trace filter knows no order and no skill: the traces of the source.
            query.node === "skill" ? [] : [{ by: query.node, value: source }],
          )
        }
      />
    );
  if (query.kind === "step_flow" && result.kind === "step_flow")
    return result.paths.every(({ steps }) => steps.length === 0) ? (
      <EmptyState
        icon={Waypoints}
        title="No steps in this time range"
        description={
          result.sample.matched === 0
            ? "No trace matches. Try a longer range or fewer filters."
            : query.mode === "before"
              ? `No trace has a step before ${query.target}.`
              : `No matching trace has a ${flowNodeNoun(query.node)}.`
        }
      />
    ) : (
      <StepFlowChart
        query={query}
        result={result}
        label={widgetName(widget)}
        fill={fill}
        nodeHref={(node) => {
          const filter = stepFlowFilter(query, node);
          return (
            filter &&
            widgetTracesHref(projectId, withClause<TraceFilter>(filter, dashboardFilters), range)
          );
        }}
      />
    );
  if (query.kind === "funnel" && result.kind === "funnel")
    return result.sample.matched === 0 ? (
      <EmptyState
        icon={Funnel}
        title="No traces in this time range"
        description="Try a longer range or fewer filters."
      />
    ) : (
      <FunnelChart
        result={result}
        label={widgetName(widget)}
        fill={fill}
        stepHref={(index) => {
          const filter = funnelStepFilter(query, index);
          return (
            filter &&
            widgetTracesHref(projectId, withClause<TraceFilter>(filter, dashboardFilters), range)
          );
        }}
      />
    );
  if (query.kind === "clusters" && result.kind === "clusters")
    return (
      <ClustersBody
        projectId={projectId}
        // The dashboards fill the seam, so its model is theirs.
        result={result as DashboardClusters}
        fill={fill}
      />
    );
  if (query.kind === "geography" && result.kind === "geography") {
    const [{ measure, aggregation }] = query.measures;
    const metric = getMetric(measure);
    return metric ? (
      <GeographyChart
        query={query}
        result={result}
        unit={metric.unit}
        label={widgetName(widget)}
        valueLabel={
          aggregation.startsWith("p") || (aggregation === "avg" && metric.source !== "scores")
            ? aggregationLabel(aggregation)
            : metric.label
        }
        samplesLabel={metric.source === "scores" ? "Results" : "Traces"}
        fill={fill}
      />
    ) : null;
  }
  return null;
}

function MetricBody({
  projectId,
  query,
  widget,
  result,
  range,
  filters: dashboardFilters,
  fill,
}: {
  projectId: string;
  query: MetricQuery;
  widget: WidgetInput;
  result: MetricResult;
  range: DashboardRange;
  filters: DashboardFilters;
  fill: boolean;
}) {
  const [{ measure, aggregation }] = query.measures;
  const metric = getMetric(measure);
  if (!metric) return null;
  // A scorer scores only new traces, so a chosen one without results may be new.
  if (isEmptyResult(result) && metric.source === "scores" && query.filters.scorer)
    return <StillCalculating />;
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
    const noun = SAMPLE_NOUN[metric.source];
    return (
      <StatRow
        className="grid-cols-1 rounded-none border-0 lg:grid-cols-1 [&>*]:p-0"
        stats={[
          {
            label: aggregationLabel(aggregation),
            value: formatMetric(total, unit),
            hint: `${formatInteger(samples)} ${noun}${samples === 1 ? "" : "s"}`,
          },
        ]}
      />
    );
  }
  if (widget.chart === "table") {
    const { dimensions } = query;
    const filters = queryFilter(query);
    return (
      <DataTable
        caption={widgetName(widget)}
        density="compact"
        rows={result.series}
        rowKey={seriesKey}
        columns={[
          ...dimensions.map((by, index) => ({
            id: by,
            header: dimensionLabel(by),
            className: "max-w-0 truncate",
            cell: ({ groups }: MetricResult["series"][number]) => {
              const { value, label } = groups[index];
              return (
                <Link
                  href={
                    by === "scorer"
                      ? scorerHref(projectId, value)
                      : widgetTracesHref(
                          projectId,
                          withClause<TraceFilter>(filters, dashboardFilters),
                          range,
                          groups.map((group, at) => ({ by: dimensions[at], value: group.value })),
                        )
                  }
                  className="text-fg hover:underline"
                  title={label ?? value}
                >
                  {label ?? value}
                </Link>
              );
            },
          })),
          ...(metric.unit === "count"
            ? []
            : [
                {
                  id: "traces",
                  header: metric.source === "scores" ? "Results" : "Traces",
                  align: "right" as const,
                  width: "6rem",
                  cell: (row: MetricResult["series"][number]) => formatInteger(row.samples),
                },
              ]),
          {
            id: "value",
            header:
              (aggregation === "avg" && metric.source !== "scores") || aggregation.startsWith("p")
                ? aggregationLabel(aggregation)
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
      model={chartModel(result, aggregation, unit, chart)}
      result={result}
      unit={unit}
      label={widgetName(widget)}
      fill={fill}
    />
  );
}
