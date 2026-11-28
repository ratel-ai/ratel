"use client";

import { ConfirmDialog } from "@ratel/design-system/dialog";
import { Field } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { useState } from "react";
import { useScorers } from "@/components/console/scorers/ScorerPickerProvider";
import {
  type Dimension,
  MAX_DIMENSIONS,
  type MetricForm,
  metricQuery,
} from "@/lib/contracts/query";
import { getMetric } from "@/lib/synthesis/metrics/catalog";
import type { TraceFilterBarFacets } from "@/lib/synthesis/traces/v2/filters";
import { type DashboardRange, rangeWindow } from "@/lib/views/dashboards/links";
import { formBucket, metricAsRql } from "@/lib/views/dashboards/metric-rql";
import { chartChoices } from "@/lib/views/dashboards/sql-chart";
import {
  METRIC_CHARTS,
  type MetricWidget,
  type WidgetInput,
  type WidgetResult,
} from "@/lib/views/dashboards/types";
import {
  CHART_LABELS,
  changeForm,
  dimensionLabel,
  fitWidget,
  formOf,
  type QueryChange,
  queryFilter,
  sqlWidgetQuery,
} from "@/lib/views/dashboards/widget";
import { Choice, MetricFields, QueryFilter } from "./MetricFields";
import { SqlFields } from "./SqlFields";

const NO_GROUP = "none";
/** What the dropdowns show before any metric was picked: a text written by hand from the start. */
const FIRST_FORM = formOf(metricQuery("trace_count", "count"));

/**
 * A metric widget: the dropdowns of the metric form, and under them the RQL text that always runs.
 * A dropdown writes the text of its selection. An edit of the text makes the widget Custom: the
 * Metric dropdown says so, and Aggregation and Group by are off. Picking a metric again resets the
 * text, after a warning that keeps the text on cancel. The Chart control offers what the rows can
 * fill, with the reason for each one they cannot.
 */
export function MetricWidgetFields({
  widget,
  range,
  result,
  facets,
  onChange,
}: {
  widget: MetricWidget;
  /** The page's range: the text of a selection with no bucket of its own follows it. */
  range?: DashboardRange;
  result: WidgetResult | null;
  facets: TraceFilterBarFacets;
  onChange: (change: (current: WidgetInput) => WidgetInput) => void;
}) {
  const scorers = useScorers();
  const { query, chart } = widget;
  const { form } = query;
  const [last, setLast] = useState<MetricForm>(form ?? FIRST_FORM);
  const [reset, setReset] = useState<QueryChange | null>(null);
  const shown = form ?? last;
  const metric = getMetric(shown.measures[0].measure);
  const text = form
    ? metricAsRql(
        form,
        chart,
        range ? formBucket(form, rangeWindow(range)) : (form.bucket ?? "hour"),
      )
    : query.text;

  const apply = (change: QueryChange) => {
    const next = changeForm(shown, change, scorers ?? []);
    setLast(next);
    onChange((current) => {
      // A table of no group is one row: a metric picked from a hand-written text starts as a line.
      const drawn =
        !form && current.chart === "table" && next.dimensions.length === 0 ? "line" : current.chart;
      return fitWidget({ ...current, chart: drawn, query: { ...query, form: next } });
    });
  };
  const choose = (change: QueryChange) => {
    if (!form && change.measure) setReset(change);
    else apply(change);
  };
  const setDimension = (index: number, value: string) =>
    choose({
      dimensions:
        value === NO_GROUP
          ? shown.dimensions.toSpliced(index, 1)
          : shown.dimensions.toSpliced(index, 1, value as Dimension),
    });
  const groupable = (metric?.dimensions.length ?? 0) > 0 && Boolean(form) && chart !== "number";
  const choices = Math.min(MAX_DIMENSIONS, shown.dimensions.length + 1);
  // A selection writes a text for each chart; a hand-written text fills what its rows fill.
  const fits = !form && result?.kind === "sql" ? chartChoices(result) : null;
  const off = METRIC_CHARTS.flatMap((value) =>
    fits?.[value] ? [`${CHART_LABELS[value]}: ${fits[value]}`] : [],
  );

  return (
    <>
      <MetricFields query={shown} custom={!form} onChange={choose}>
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
                disabled={!groupable}
                options={[
                  { value: NO_GROUP, label: "No grouping" },
                  ...(metric?.dimensions ?? [])
                    .filter(
                      (value) =>
                        !shown.dimensions.includes(value) || value === shown.dimensions[index],
                    )
                    .map((value) => ({ value, label: dimensionLabel(value) })),
                ]}
                value={shown.dimensions[index] ?? NO_GROUP}
                onValueChange={(value) => setDimension(index, String(value))}
              />
            )}
          </Field>
        ))}
      </MetricFields>
      <SqlFields
        text={text}
        result={result}
        onRun={(next) => {
          if (form && next.replace(/\s+/g, " ").trim() === text.replace(/\s+/g, " ").trim()) return;
          // An edited text is Custom: it no longer follows the dropdowns.
          if (form) setLast(form);
          onChange((current) => fitWidget({ ...current, query: sqlWidgetQuery(next) }));
        }}
      />
      <Choice label="Chart">
        <div className="flex flex-col gap-1">
          <div className="flex">
            <SegmentedControl
              label="Chart"
              options={METRIC_CHARTS.map((value) => ({
                value,
                label: CHART_LABELS[value],
                disabled: Boolean(fits?.[value]),
              }))}
              value={chart}
              onValueChange={(next) =>
                onChange((current) => fitWidget({ ...current, chart: next }))
              }
            />
          </div>
          {off.map((reason) => (
            <p key={reason} className="text-xs text-fg-subtle">
              {reason}
            </p>
          ))}
        </div>
      </Choice>
      {form && metric?.filterable ? (
        <QueryFilter
          filter={queryFilter(query)}
          facets={facets}
          onChange={(next) => apply({ filter: next(queryFilter(query)) })}
        />
      ) : null}
      <ConfirmDialog
        open={reset !== null}
        onOpenChange={(open) => {
          if (!open) setReset(null);
        }}
        title="Reset the RQL text?"
        description={`The text becomes the text of ${getMetric(reset?.measure ?? "")?.label ?? "the metric"}, and your edits to it are lost.`}
        confirmLabel="Reset text"
        onConfirm={() => {
          if (reset) apply(reset);
          setReset(null);
        }}
      />
    </>
  );
}
