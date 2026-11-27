"use client";

import { Field } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import type { ReactNode } from "react";
import { PropertyFilterFields } from "@/components/console/properties/PropertyFilterFields";
import { ScorerPicker } from "@/components/console/scorers/ScorerPicker";
import { useScorers } from "@/components/console/scorers/ScorerPickerProvider";
import { TraceFilterBar } from "@/components/console/traces/TraceFilterBar";
import type { Aggregation, MeasureId, MetricQuery } from "@/lib/contracts/query";
import { getMetric, offeredMetrics } from "@/lib/synthesis/metrics/catalog";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import {
  type TraceFilterBarFacets,
  traceFilterFromSearch,
} from "@/lib/synthesis/traces/v2/filters";
import { searchFromTraceFilter } from "@/lib/views/dashboards/links";
import { aggregationLabel, type QueryChange, scorersOfMetric } from "@/lib/views/dashboards/widget";

/** The Metric dropdown's choice for a text written by hand. */
export const CUSTOM_METRIC = "custom";

/**
 * What is measured: the metric, its aggregation and its scorer. `children` follow the aggregation.
 * The metrics of scorers show only while scorers are on (a `ScorerPickerProvider` with data).
 * With `custom`, the Metric dropdown offers `Custom` too: while it is chosen, the aggregation is
 * off and `query` is the last selection, shown for what it was.
 */
export function MetricFields({
  query,
  filterableOnly = false,
  custom,
  onChange,
  children,
}: {
  query: Pick<MetricQuery, "measures" | "filters">;
  /** Only the metrics of traces that a trace filter applies to. */
  filterableOnly?: boolean;
  /** The RQL text is written by hand: `Custom` is chosen. */
  custom?: boolean;
  onChange: (change: QueryChange) => void;
  children?: ReactNode;
}) {
  const scorers = useScorers();
  const [{ measure, aggregation }] = query.measures;
  const metric = getMetric(measure);
  if (!metric) return null;
  const readable = new Set(scorersOfMetric(measure, scorers ?? []).map(({ id }) => id));
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
      <Field label="Metric" className="min-w-40 flex-1">
        {(control) => (
          <Select
            {...control}
            className="w-full"
            options={[
              ...offeredMetrics({ customMonitoring: scorers !== null })
                .filter(({ filterable }) => filterable || !filterableOnly)
                .map(({ id, label }) => ({ value: id, label })),
              ...(custom === undefined ? [] : [{ value: CUSTOM_METRIC, label: "Custom" }]),
            ]}
            value={custom ? CUSTOM_METRIC : measure}
            onValueChange={(value) => {
              if (value !== CUSTOM_METRIC) onChange({ measure: value as MeasureId });
            }}
          />
        )}
      </Field>
      <Field label="Aggregation" className="min-w-40 flex-1">
        {(control) => (
          <Select
            {...control}
            className="w-full"
            disabled={custom || metric.aggregations.length === 1}
            options={metric.aggregations.map((value) => ({
              value,
              label: aggregationLabel(value),
            }))}
            value={aggregation}
            onValueChange={(value) => onChange({ aggregation: value as Aggregation })}
          />
        )}
      </Field>
      {children}
      {metric.source === "scores" && !custom ? (
        <Field label="Scorer" className="min-w-40 flex-1">
          {({ id }) => (
            <ScorerPicker
              id={id}
              className="w-full"
              allLabel="All scorers"
              filter={(scorer) => readable.has(scorer.id)}
              value={query.filters.scorer?.id ?? null}
              onChange={(scorerId) => onChange({ scorerId })}
            />
          )}
        </Field>
      ) : null}
    </div>
  );
}

/** The trace filter of a metric; nothing for a metric that has none. */
export function MetricFilter({
  query,
  facets,
  onChange,
}: {
  query: MetricQuery;
  facets: TraceFilterBarFacets;
  onChange: (next: (current: TraceFilter) => TraceFilter) => void;
}) {
  if (!getMetric(query.measures[0].measure)?.filterable) return null;
  return <QueryFilter filter={query.filters} facets={facets} onChange={onChange} />;
}

/**
 * A trace filter as the Traces page edits it, with the trace properties of the surface (RTL-397):
 * the bar shows every part of the filter as a chip, properties too, and their pickers follow
 * "Filter". The Metric, Flow, Step flow, Funnel and Map forms all edit their filter here.
 */
export function QueryFilter({
  filter,
  facets,
  onChange,
}: {
  filter: TraceFilter;
  facets: TraceFilterBarFacets;
  onChange: (next: (current: TraceFilter) => TraceFilter) => void;
}) {
  return (
    <Choice label="Filter">
      <TraceFilterBar
        tab="rollup"
        entities
        searchable={false}
        pending={false}
        facets={facets}
        search={searchFromTraceFilter(filter)}
        onSearchChange={(next) =>
          onChange((current) => {
            const search = searchFromTraceFilter(current);
            return traceFilterFromSearch(typeof next === "function" ? next(search) : next, {
              entities: true,
            });
          })
        }
        more={<PropertyFilterFields filter={filter} chips={false} onChange={onChange} />}
      />
    </Choice>
  );
}

/** A labelled control that is not one input: a segmented control, the filter bar. */
export function Choice({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span aria-hidden className="text-xs font-medium text-fg-muted">
        {label}
      </span>
      {children}
    </div>
  );
}
