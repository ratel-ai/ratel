"use client";

import { Field } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import type { ReactNode } from "react";
import { TraceFilterBar } from "@/components/console/traces/TraceFilterBar";
import {
  getMetric,
  type MetricAggregation,
  type MetricId,
  offeredMetrics,
} from "@/lib/synthesis/metrics/catalog";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import {
  type TraceFilterBarFacets,
  traceFilterFromSearch,
} from "@/lib/synthesis/traces/v2/filters";
import { searchFromTraceFilter } from "@/lib/views/dashboards/links";
import type { ScorerOption, WidgetInput } from "@/lib/views/dashboards/types";
import { aggregationLabel, fitWidget, scorersOfMetric } from "@/lib/views/dashboards/widget";

const ALL_SCORERS = "all";

type MetricQuery = Pick<WidgetInput, "metric" | "aggregation" | "filter" | "scorerId">;

/** What is measured: the metric, its aggregation and its scorer. `children` follow the aggregation. */
export function MetricFields({
  query,
  scorers,
  onChange,
  children,
}: {
  query: MetricQuery;
  /** The project's scorers; null while scorers are off, and their metrics are then not offered. */
  scorers: readonly ScorerOption[] | null;
  onChange: (change: Partial<MetricQuery>) => void;
  children?: ReactNode;
}) {
  const metric = getMetric(query.metric);
  if (!metric) return null;
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
      <Field label="Metric" className="min-w-40 flex-1">
        {(control) => (
          <Select
            {...control}
            className="w-full"
            options={offeredMetrics({ scorers: scorers !== null }).map(({ id, label }) => ({
              value: id,
              label,
            }))}
            value={query.metric}
            onValueChange={(value) => onChange({ metric: value as MetricId })}
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
            value={query.aggregation}
            onValueChange={(value) => onChange({ aggregation: value as MetricAggregation })}
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
                ...scorersOfMetric(query.metric, scorers ?? []).map(({ id, name }) => ({
                  value: id,
                  label: name,
                })),
              ]}
              value={query.scorerId ?? ALL_SCORERS}
              onValueChange={(value) =>
                onChange({ scorerId: value === ALL_SCORERS ? undefined : String(value) })
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
  query: Pick<MetricQuery, "metric" | "filter">;
  facets: TraceFilterBarFacets;
  onChange: (next: (current: TraceFilter) => TraceFilter) => void;
}) {
  if (!getMetric(query.metric)?.filterable) return null;
  return (
    <Choice label="Filter">
      <TraceFilterBar
        tab="rollup"
        entities
        searchable={false}
        pending={false}
        facets={facets}
        search={searchFromTraceFilter(query.filter)}
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

/** Every change lands on a widget the rules allow, so Save never has to refuse one. */
export function changedWidget(
  current: WidgetInput,
  change: Partial<WidgetInput>,
  scorers: readonly ScorerOption[],
): WidgetInput {
  const next = fitWidget({ ...current, ...change });
  // A pass rate has no 1 to 5 scorer, and the average no pass or fail one.
  const fits = scorersOfMetric(next.metric, scorers).some(({ id }) => id === next.scorerId);
  return fits ? next : { ...next, scorerId: undefined };
}
