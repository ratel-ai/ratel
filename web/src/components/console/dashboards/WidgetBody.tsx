"use client";

import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { DataTable } from "@ratel/design-system/data-table";
import { StatRow } from "@ratel/design-system/stat-row";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { ArrowLeft, ChartColumn, CircleAlert, Funnel, Waypoints } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { StillCalculating } from "@/components/console/scorers/StillCalculating";
import type { MetricQuery } from "@/lib/contracts/query";
import { getMetric, type MetricSource } from "@/lib/synthesis/metrics/catalog";
import { groupQuery } from "@/lib/synthesis/metrics/group-query";
import type { GroupedResult } from "@/lib/synthesis/metrics/groups";
import type { MetricResult } from "@/lib/synthesis/metrics/query";
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
  groupByLabel,
  groupValueLabel,
  leftOutNote,
  NO_VALUE,
} from "@/lib/views/dashboards/grouped";
import {
  type DashboardRange,
  funnelStepFilter,
  rangeWindow,
  stepFlowFilter,
  widgetTracesHref,
} from "@/lib/views/dashboards/links";
import { propertySettingsHref } from "@/lib/views/dashboards/properties";
import { formAsMetric, sqlResultNotes } from "@/lib/views/dashboards/sql-chart";
import type { DashboardFilters, WidgetInput, WidgetResult } from "@/lib/views/dashboards/types";
import {
  aggregationLabel,
  dimensionLabel,
  flowNodeNoun,
  isMetricChart,
  metricOfForm,
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
import { useTaskNames } from "./TaskNamesProvider";

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
  expanded = false,
  compact = false,
}: {
  projectId: string;
  widget: WidgetInput;
  result: WidgetResult | null;
  range: DashboardRange;
  /** The dashboard's, for the links to what a widget shows. */
  filters: DashboardFilters;
  /** False while the switch of the metric is off. */
  available?: boolean;
  /** The scorer of an imported widget, when the project does not have it. */
  missingScorer?: string;
  /** The chart takes the height of the place it is in. */
  fill?: boolean;
  /** Shown large, in place of the grid: a small chart of a group-by opens its value alone. */
  expanded?: boolean;
  /** One small chart of a group-by: the chart alone, without its notes. */
  compact?: boolean;
}) {
  const { query } = widget;
  const taskNames = useTaskNames();
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
  // A widget on a property that is no longer indexed says so, with the way back.
  if (result.kind === "refused" && result.code === "property_not_indexed" && result.property)
    return (
      <EmptyState
        icon={CircleAlert}
        title="Property is not indexed"
        description={`${result.property} is not indexed, so this widget has no numbers. Index it again to see them.`}
        action={
          <Link
            href={propertySettingsHref(projectId, result.property)}
            className="text-ui font-medium text-fg underline hover:text-fg-muted"
          >
            Index it in project settings
          </Link>
        }
      />
    );
  if (result.kind === "grouped")
    return (
      <GroupedBody
        projectId={projectId}
        widget={widget}
        result={result}
        range={range}
        filters={dashboardFilters}
        expanded={expanded}
      />
    );
  if (result.kind === "refused")
    return (
      <Callout tone="danger" title="RQL refused the query">
        {result.message} Fix: {result.fix}
      </Callout>
    );
  if (query.kind === "sql") {
    const chart = isMetricChart(widget.chart) ? widget.chart : "table";
    // A text of the form draws as the form did; query_monitoring gives a metric's own result.
    if (query.form && (result.kind === "metric" || result.kind === "sql")) {
      // A text cut at the row cap says so under its chart, as a hand-written one does.
      const notes = result.kind === "sql" ? sqlResultNotes(result) : [];
      const body = (
        <MetricBody
          projectId={projectId}
          query={metricOfForm(query.form)}
          widget={{ ...widget, chart }}
          result={
            result.kind === "metric"
              ? result
              : formAsMetric(result, query.form, chart, rangeWindow(range), { taskNames })
          }
          samples={result.kind === "metric"}
          range={range}
          filters={dashboardFilters}
          fill={fill}
        />
      );
      if (notes.length === 0) return body;
      return (
        <div className={cn("flex min-w-0 flex-col gap-2", fill && "h-full min-h-0")}>
          <div className={fill ? "flex min-h-0 flex-1 flex-col" : undefined}>{body}</div>
          {notes.map((note) => (
            <p key={note} className="shrink-0 text-xs text-fg-subtle">
              {note}
            </p>
          ))}
        </div>
      );
    }
    if (result.kind === "sql")
      return <SqlBody result={result} chart={chart} label={widgetName(widget)} fill={fill} />;
  }
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
        compact={compact}
      />
    ) : null;
  }
  return null;
}

/**
 * A widget with a group-by (RTL-398): one small chart per value, the most traces first, each with
 * its value as its title and its traces, and how many values are left out. Expanded, a click on a
 * small chart opens its value alone, as a filter of the widget, until "All values".
 */
function GroupedBody({
  projectId,
  widget,
  result,
  range,
  filters,
  expanded,
}: {
  projectId: string;
  widget: WidgetInput;
  result: GroupedResult;
  range: DashboardRange;
  filters: DashboardFilters;
  expanded: boolean;
}) {
  const taskNames = useTaskNames();
  const [focused, setFocused] = useState<number | null>(null);
  const { by, groups, leftOut } = result;
  const label = (value: string | null) => groupValueLabel(by, value, taskNames);
  const small = (value: string | null) => ({
    ...widget,
    title: label(value),
    query: groupQuery(widget.query, value) as WidgetInput["query"],
  });
  if (groups.length === 0)
    return (
      <EmptyState
        icon={Waypoints}
        title="No traces in this time range"
        description="Try a longer range or fewer filters."
      />
    );
  const alone = focused === null ? undefined : groups[focused];
  if (alone)
    return (
      <div className="flex h-full min-h-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Button variant="ghost" size="sm" onClick={() => setFocused(null)}>
            <ArrowLeft aria-hidden /> All values
          </Button>
          <span className="rounded-md border border-line bg-surface px-2 py-0.5 text-fg">
            {groupByLabel(by)} = {label(alone.value)}
          </span>
          <span className="text-fg-subtle">{tracesOf(alone.traces)}</span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <WidgetBody
            projectId={projectId}
            widget={small(alone.value)}
            result={alone.result}
            range={range}
            filters={filters}
            fill
          />
        </div>
      </div>
    );
  const note = leftOutNote(leftOut);
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <ul
        aria-label={`By ${groupByLabel(by)}`}
        className={cn(
          "grid min-h-0 flex-1 gap-2 overflow-auto",
          expanded
            ? "auto-rows-[minmax(14rem,1fr)] grid-cols-[repeat(auto-fill,minmax(18rem,1fr))]"
            : "auto-rows-[minmax(8.5rem,1fr)] grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]",
          // A step flow needs the width of its columns to read.
          widget.query.kind === "step_flow" &&
            (expanded
              ? "grid-cols-[repeat(auto-fill,minmax(30rem,1fr))]"
              : "grid-cols-[repeat(auto-fill,minmax(22rem,1fr))]"),
        )}
      >
        {groups.map((group, index) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the title is the button of the keyboard.
          <li
            key={group.value ?? NO_VALUE}
            className={cn(
              "flex min-h-0 min-w-0 flex-col gap-1 rounded-md border border-line p-2",
              expanded && "cursor-pointer hover:border-line-strong",
            )}
            onClick={(event) => {
              // A link or a control of the chart keeps its own click.
              if (!expanded || (event.target as Element).closest("a, button, input")) return;
              setFocused(index);
            }}
          >
            <div className="flex min-w-0 items-baseline justify-between gap-2 text-xs">
              {expanded ? (
                <button
                  type="button"
                  className="min-w-0 truncate text-left font-medium text-fg hover:underline"
                  title={`Open ${label(group.value)} alone`}
                  onClick={() => setFocused(index)}
                >
                  {label(group.value)}
                </button>
              ) : (
                <span className="min-w-0 truncate font-medium text-fg" title={label(group.value)}>
                  {label(group.value)}
                </span>
              )}
              <span className="shrink-0 text-fg-subtle">{tracesOf(group.traces)}</span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <WidgetBody
                projectId={projectId}
                widget={small(group.value)}
                result={group.result}
                range={range}
                filters={filters}
                fill
                compact
              />
            </div>
          </li>
        ))}
      </ul>
      {note ? <p className="text-xs text-fg-subtle">{note}</p> : null}
    </div>
  );
}

function tracesOf(count: number): string {
  return `${formatInteger(count)} trace${count === 1 ? "" : "s"}`;
}

function MetricBody({
  projectId,
  query,
  widget,
  result,
  samples: counted,
  range,
  filters: dashboardFilters,
  fill,
}: {
  projectId: string;
  query: MetricQuery;
  widget: WidgetInput;
  result: MetricResult;
  /** False for the rows of RQL text: they give the values, not the rows behind them. */
  samples: boolean;
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
            ...(counted
              ? { hint: `${formatInteger(samples)} ${noun}${samples === 1 ? "" : "s"}` }
              : {}),
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
            id: typeof by === "string" ? by : `property:${by.property}`,
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
          ...(metric.unit === "count" || !counted
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
