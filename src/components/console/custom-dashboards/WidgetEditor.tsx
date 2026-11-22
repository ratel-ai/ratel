"use client";

import { Button } from "@ratel/design-system/button";
import { DialogClose, DialogContent } from "@ratel/design-system/dialog";
import { Field } from "@ratel/design-system/input";
import { Select, type SelectOption } from "@ratel/design-system/select";
import { type FormEvent, useState } from "react";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import {
  CHART_LABELS,
  GROUP_BY_LABELS,
  METRIC_LABELS,
  RANGE_LABELS,
} from "@/lib/views/custom-dashboards/present";
import {
  chartFitsGroupBy,
  PIVOT_GROUP_PREFIX,
  WIDGET_CHARTS,
  WIDGET_FIXED_GROUP_BYS,
  WIDGET_METRICS,
  WIDGET_RANGE_DAYS,
  type WidgetChart,
  type WidgetGroupBy,
  type WidgetMetric,
  type WidgetRangeDays,
  type WidgetSpec,
} from "@/lib/views/custom-dashboards/spec";

/**
 * The widget editor (RC-888): a form over the widget spec. Five fields:
 * metric, group-by (the fixed ones and the project's pivots), chart, range and
 * one filter. The chart list follows the group-by, so the form never makes a
 * spec the server refuses for that reason.
 */

export interface EditorPivot {
  key: string;
  label: string;
}

/** The values the filter offers, from the project's recent traces. */
export interface EditorFacets {
  model: string[];
  service: string[];
  environment: string[];
}

const NO_GROUP = "none";
const ANY = "any";
const KEPT = "kept";

export function WidgetEditor({
  title,
  submitLabel,
  initial,
  pivots,
  facets,
  pending,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  initial?: WidgetSpec;
  pivots: readonly EditorPivot[];
  facets: EditorFacets;
  pending: boolean;
  onSubmit: (spec: WidgetSpec) => void;
}) {
  const [metric, setMetric] = useState<WidgetMetric>(initial?.metric ?? "runs");
  const [groupBy, setGroupBy] = useState<string>(initial?.groupBy ?? NO_GROUP);
  const [chart, setChart] = useState<WidgetChart>(initial?.chart ?? "kpi");
  const [rangeDays, setRangeDays] = useState<WidgetRangeDays>(initial?.rangeDays ?? 7);
  const [filter, setFilter] = useState<string>(filterChoice(initial?.filter));

  const group = groupBy === NO_GROUP ? null : (groupBy as WidgetGroupBy);
  const charts = WIDGET_CHARTS.filter((candidate) => chartFitsGroupBy(candidate, group));
  const groupOptions: SelectOption[] = [
    { value: NO_GROUP, label: "None" },
    ...WIDGET_FIXED_GROUP_BYS.map((value) => ({ value, label: GROUP_BY_LABELS[value] })),
    ...pivots.map((pivot) => ({
      value: `${PIVOT_GROUP_PREFIX}${pivot.key}`,
      label: `Pivot: ${pivot.label}`,
    })),
  ];
  const filterOptions: SelectOption[] = [
    { value: ANY, label: "All runs" },
    { value: "status:failed", label: "Failed runs" },
    { value: "status:ok", label: "Successful runs" },
    ...facets.model.map((value) => ({ value: `model:${value}`, label: `Model is ${value}` })),
    ...facets.service.map((value) => ({ value: `service:${value}`, label: `Service is ${value}` })),
    ...facets.environment.map((value) => ({
      value: `environment:${value}`,
      label: `Environment is ${value}`,
    })),
    ...(filter === KEPT ? [{ value: KEPT, label: "The current filter" }] : []),
  ];

  function pickGroup(value: string) {
    setGroupBy(value);
    const next = value === NO_GROUP ? null : (value as WidgetGroupBy);
    if (!chartFitsGroupBy(chart, next))
      setChart(next === null ? "kpi" : next === "day" ? "line" : "bar");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({
      metric,
      groupBy: group,
      chart,
      rangeDays,
      filter: filter === KEPT ? (initial?.filter ?? {}) : toFilter(filter),
      ...(initial?.topN && group !== "day" ? { topN: initial.topN } : {}),
    });
  }

  return (
    <DialogContent
      title={title}
      footer={
        <>
          <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
          <Button type="submit" form="widget-editor" variant="primary" loading={pending}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id="widget-editor" onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Metric">
          {(props) => (
            <Select
              {...props}
              options={WIDGET_METRICS.map((value) => ({ value, label: METRIC_LABELS[value] }))}
              value={metric}
              onValueChange={(value) => setMetric(value as WidgetMetric)}
            />
          )}
        </Field>
        <Field label="Group by" description="Groups past the top 20 merge into Other.">
          {(props) => (
            <Select {...props} options={groupOptions} value={groupBy} onValueChange={pickGroup} />
          )}
        </Field>
        <Field label="Chart">
          {(props) => (
            <Select
              {...props}
              options={charts.map((value) => ({ value, label: CHART_LABELS[value] }))}
              value={chart}
              onValueChange={(value) => setChart(value as WidgetChart)}
            />
          )}
        </Field>
        <Field label="Range">
          {(props) => (
            <Select
              {...props}
              options={WIDGET_RANGE_DAYS.map((value) => ({
                value: String(value),
                label: RANGE_LABELS[value],
              }))}
              value={String(rangeDays)}
              onValueChange={(value) => setRangeDays(Number(value) as WidgetRangeDays)}
            />
          )}
        </Field>
        <Field label="Runs">
          {(props) => (
            <Select {...props} options={filterOptions} value={filter} onValueChange={setFilter} />
          )}
        </Field>
      </form>
    </DialogContent>
  );
}

/** The one filter choice a spec's filter matches, or "kept" when it holds more than the form shows. */
function filterChoice(filter: TraceFilter | undefined): string {
  const entries = Object.entries(filter ?? {}).filter(
    ([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0),
  );
  if (entries.length === 0) return ANY;
  if (entries.length > 1) return KEPT;
  const [key, value] = entries[0];
  if (key === "status") return `status:${value}`;
  const single = Array.isArray(value) && value.length === 1 ? value[0] : null;
  if (single === null) return KEPT;
  if (key === "models") return `model:${single}`;
  if (key === "services") return `service:${single}`;
  if (key === "environments") return `environment:${single}`;
  return KEPT;
}

function toFilter(choice: string): TraceFilter {
  const separator = choice.indexOf(":");
  if (separator < 0) return {};
  const kind = choice.slice(0, separator);
  const value = choice.slice(separator + 1);
  switch (kind) {
    case "status":
      return value === "failed" || value === "ok" ? { status: value } : {};
    case "model":
      return { models: [value] };
    case "service":
      return { services: [value] };
    case "environment":
      return { environments: [value] };
    default:
      return {};
  }
}
