"use client";

import { Field } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import type { ReactNode } from "react";
import { TraceFilterBar } from "@/components/console/traces/TraceFilterBar";
import type { Aggregation, MeasureId, MetricQuery } from "@/lib/contracts/query";
import { getMetric, offeredMetrics } from "@/lib/synthesis/metrics/catalog";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import {
  type TraceFilterBarFacets,
  traceFilterFromSearch,
} from "@/lib/synthesis/traces/v2/filters";
import { searchFromTraceFilter } from "@/lib/views/dashboards/links";
import type { ScorerOption } from "@/lib/views/dashboards/types";
import { aggregationLabel, type QueryChange, scorersOfMetric } from "@/lib/views/dashboards/widget";

const ALL_SCORERS = "all";

/** What is measured: the metric, its aggregation and its scorer. `children` follow the aggregation. */
export function MetricFields({
  query,
  scorers,
  filterableOnly = false,
  onChange,
  children,
}: {
  query: Pick<MetricQuery, "measures" | "filters">;
  /** The project's scorers; null while scorers are off, and their metrics are then not offered. */
  scorers: readonly ScorerOption[] | null;
  /** Only the metrics of traces that a trace filter applies to. */
  filterableOnly?: boolean;
  onChange: (change: QueryChange) => void;
  children?: ReactNode;
}) {
  const [{ measure, aggregation }] = query.measures;
  const metric = getMetric(measure);
  if (!metric) return null;
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
      <Field label="Metric" className="min-w-40 flex-1">
        {(control) => (
          <Select
            {...control}
            className="w-full"
            options={offeredMetrics({ customMonitoring: scorers !== null })
              .filter(({ filterable }) => filterable || !filterableOnly)
              .map(({ id, label }) => ({ value: id, label }))}
            value={measure}
            onValueChange={(value) => onChange({ measure: value as MeasureId })}
          />
        )}
      </Field>
      <Field label="Aggregation" className="min-w-40 flex-1">
        {(control) => (
          <Select
            {...control}
            className="w-full"
            disabled={metric.aggregations.length === 1}
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
      {metric.source === "scores" ? (
        <Field label="Scorer" className="min-w-40 flex-1">
          {(control) => (
            <Select
              {...control}
              className="w-full"
              options={[
                { value: ALL_SCORERS, label: "All scorers" },
                ...scorersOfMetric(measure, scorers ?? []).map(({ id, name }) => ({
                  value: id,
                  label: name,
                })),
              ]}
              value={query.filters.scorer?.id ?? ALL_SCORERS}
              onValueChange={(value) =>
                onChange({ scorerId: value === ALL_SCORERS ? null : String(value) })
              }
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

/** A trace filter as the Traces page edits it. */
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
