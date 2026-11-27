"use client";

import { Field, Input } from "@ratel/design-system/input";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { useScorers } from "@/components/console/scorers/ScorerPickerProvider";
import type { TraceFilterBarFacets } from "@/lib/synthesis/traces/v2/filters";
import type { DashboardRange } from "@/lib/views/dashboards/links";
import {
  MAX_WIDGET_TITLE,
  WIDGET_KINDS,
  type WidgetInput,
  type WidgetQuery,
  type WidgetResult,
} from "@/lib/views/dashboards/types";
import {
  changeGeography,
  fitWidget,
  isFilterable,
  isMetricChart,
  KIND_LABELS,
  queryFilter,
  widgetName,
  widgetOfKind,
  withFilter,
} from "@/lib/views/dashboards/widget";
import { ClustersFields } from "./ClustersFields";
import { FlowFields } from "./FlowFields";
import { FunnelFields } from "./FunnelFields";
import { GeographyFields } from "./GeographyFields";
import { GroupByFields } from "./GroupByFields";
import { Choice, QueryFilter } from "./MetricFields";
import { MetricWidgetFields } from "./MetricWidgetFields";
import { StepFlowFields } from "./StepFlowFields";

export type RefusedField = "query" | "title" | "filter";

/** What a person sets of a widget: the fields of the widget editor and of an Explore panel. */
export function WidgetFields({
  widget,
  onChange,
  facets,
  result,
  refused,
  range,
}: {
  widget: WidgetInput;
  onChange: (change: (current: WidgetInput) => WidgetInput) => void;
  facets: TraceFilterBarFacets;
  /** The last result read, for the names it offers. */
  result: WidgetResult | null;
  /** A change that was not made, said at its field. */
  refused?: { field: RefusedField; message: string } | null;
  /** The page's range: the RQL text of a metric with no bucket of its own follows it. */
  range?: DashboardRange;
}) {
  const { query } = widget;
  const scorers = useScorers();
  const set = (change: Partial<WidgetInput>) =>
    onChange((current) => fitWidget({ ...current, ...change }));
  const setQuery = (change: (query: WidgetQuery) => WidgetQuery) =>
    onChange((current) => fitWidget({ ...current, query: change(current.query) }));

  const refusal = (field: RefusedField) =>
    refused?.field === field ? (
      <p role="alert" className="text-xs text-danger">
        Not changed. {refused.message}
      </p>
    ) : null;

  return (
    <>
      <Choice label="Show">
        <div className="flex">
          <SegmentedControl
            label="Show"
            options={WIDGET_KINDS.map((value) => ({ value, label: KIND_LABELS[value] }))}
            value={query.kind}
            onValueChange={(kind) => onChange((current) => widgetOfKind(kind, current))}
          />
        </div>
      </Choice>
      {query.kind === "sql" && isMetricChart(widget.chart) ? (
        <MetricWidgetFields
          widget={{ ...widget, query, chart: widget.chart }}
          range={range}
          result={result}
          facets={facets}
          onChange={onChange}
        />
      ) : null}
      {query.kind === "flow" ? (
        <FlowFields query={query} facets={facets} onChange={(next) => set({ query: next })} />
      ) : null}
      {query.kind === "step_flow" ? (
        <StepFlowFields query={query} facets={facets} onChange={(next) => set({ query: next })} />
      ) : null}
      {query.kind === "clusters" ? (
        <ClustersFields
          query={query}
          names={result?.kind === "clusters" ? result.names : undefined}
          onChange={(next) => set({ query: next })}
        />
      ) : null}
      {query.kind === "geography" ? (
        <GeographyFields
          query={query}
          onMeasure={(change) =>
            setQuery((current) =>
              current.kind === "geography"
                ? changeGeography(current, change, scorers ?? [])
                : current,
            )
          }
          onChange={(next) => set({ query: next })}
        />
      ) : null}
      {query.kind === "funnel" ? (
        <FunnelFields query={query} facets={facets} onChange={(next) => set({ query: next })} />
      ) : null}
      {query.kind === "flow" ||
      query.kind === "step_flow" ||
      query.kind === "funnel" ||
      query.kind === "geography" ? (
        <GroupByFields query={query} onChange={(next) => set({ query: next })} />
      ) : null}
      {refusal("query")}
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <Field label="Title" className="min-w-40 flex-1">
          {(control) => (
            <Input
              {...control}
              value={widget.title}
              maxLength={MAX_WIDGET_TITLE}
              autoComplete="off"
              placeholder={widgetName({ ...widget, title: "" })}
              onChange={(event) => set({ title: event.currentTarget.value })}
            />
          )}
        </Field>
      </div>
      {refusal("title")}
      {isFilterable(query) ? (
        <QueryFilter
          filter={queryFilter(query)}
          facets={facets}
          onChange={(next) =>
            setQuery((current) => withFilter(current, next(queryFilter(current))))
          }
        />
      ) : null}
      {refusal("filter")}
    </>
  );
}
