"use client";

import { Field, Input } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { useScorers } from "@/components/console/scorers/ScorerPickerProvider";
import {
  type Dimension,
  MAX_DIMENSIONS,
  type MetricQuery,
  QUERY_KINDS,
  type Query,
} from "@/lib/contracts/query";
import type { QueryResult } from "@/lib/synthesis/metrics/query";
import type { TraceFilterBarFacets } from "@/lib/synthesis/traces/v2/filters";
import {
  MAX_WIDGET_TITLE,
  METRIC_CHARTS,
  type WidgetChart,
  type WidgetInput,
} from "@/lib/views/dashboards/types";
import {
  CHART_LABELS,
  changeGeography,
  changeQuery,
  dimensionLabel,
  fitWidget,
  isFilterable,
  KIND_LABELS,
  type QueryChange,
  queryFilter,
  queryMetric,
  widgetName,
  widgetOfKind,
  withFilter,
} from "@/lib/views/dashboards/widget";
import { ClustersFields } from "./ClustersFields";
import { FlowFields } from "./FlowFields";
import { FunnelFields } from "./FunnelFields";
import { GeographyFields } from "./GeographyFields";
import { Choice, MetricFields, QueryFilter } from "./MetricFields";
import { StepFlowFields } from "./StepFlowFields";

const NO_GROUP = "none";

export type RefusedField = "query" | "title" | "filter";

/** What a person sets of a widget: the fields of the widget editor and of an Explore panel. */
export function WidgetFields({
  widget,
  onChange,
  facets,
  result,
  refused,
}: {
  widget: WidgetInput;
  onChange: (change: (current: WidgetInput) => WidgetInput) => void;
  facets: TraceFilterBarFacets;
  /** The last result read, for the names it offers. */
  result: QueryResult | null;
  /** A change that was not made, said at its field. */
  refused?: { field: RefusedField; message: string } | null;
}) {
  const { query } = widget;
  const scorers = useScorers();
  const set = (change: Partial<WidgetInput>) =>
    onChange((current) => fitWidget({ ...current, ...change }));
  const setQuery = (change: (query: Query) => Query) =>
    onChange((current) => fitWidget({ ...current, query: change(current.query) }));
  const metric = queryMetric(query);

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
            options={QUERY_KINDS.map((value) => ({ value, label: KIND_LABELS[value] }))}
            value={query.kind}
            onValueChange={(kind) => onChange((current) => widgetOfKind(kind, current))}
          />
        </div>
      </Choice>
      {query.kind === "metric" ? (
        <MetricForm
          query={query}
          chart={widget.chart}
          onChange={(change) =>
            setQuery((current) =>
              current.kind === "metric" ? changeQuery(current, change, scorers ?? []) : current,
            )
          }
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
      {refusal("query")}
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        {query.kind === "metric" ? (
          <Choice label="Chart">
            <SegmentedControl
              label="Chart"
              options={METRIC_CHARTS.map((value) => ({
                value,
                label: CHART_LABELS[value],
                disabled: value === "table" && !metric?.dimensions.length,
              }))}
              value={widget.chart}
              onValueChange={(chart) => set({ chart })}
            />
          </Choice>
        ) : null}
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

/** What a metric widget measures, and by what. */
function MetricForm({
  query,
  chart,
  onChange,
}: {
  query: MetricQuery;
  chart: WidgetChart;
  onChange: (change: QueryChange) => void;
}) {
  const metric = queryMetric(query);
  if (!metric) return null;
  const groupable = metric.dimensions.length > 0;
  // One choice more than the query groups by, up to the most it may.
  const choices = Math.min(MAX_DIMENSIONS, query.dimensions.length + 1);
  const setDimension = (index: number, value: string) =>
    onChange({
      dimensions:
        value === NO_GROUP
          ? query.dimensions.toSpliced(index, 1)
          : query.dimensions.toSpliced(index, 1, value as Dimension),
    });

  return (
    <MetricFields query={query} onChange={onChange}>
      {Array.from({ length: choices }, (_, index) => (
        <Field
          // biome-ignore lint/suspicious/noArrayIndexKey: a choice is its position.
          key={index}
          label={index === 0 ? "Group by" : "And by"}
          className="min-w-40 flex-1"
        >
          {(control) => (
            <Select
              {...control}
              className="w-full"
              disabled={!groupable || chart === "number"}
              options={[
                // A table lists groups, so it always has one.
                ...(chart === "table" && query.dimensions.length < 2 && index === 0
                  ? []
                  : [{ value: NO_GROUP, label: "No grouping" }]),
                ...metric.dimensions
                  .filter(
                    (value) =>
                      !query.dimensions.includes(value) || value === query.dimensions[index],
                  )
                  .map((value) => ({ value, label: dimensionLabel(value) })),
              ]}
              value={query.dimensions[index] ?? NO_GROUP}
              onValueChange={(value) => setDimension(index, String(value))}
            />
          )}
        </Field>
      ))}
    </MetricFields>
  );
}
