"use client";

import { ConfirmDialog } from "@ratel/design-system/dialog";
import { Field } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { useState } from "react";
import { PropertyBlockNote } from "@/components/console/properties/PropertyBlockNote";
import { usePropertyChoices } from "@/components/console/properties/PropertyChoicesProvider";
import { PropertyFilterFields } from "@/components/console/properties/PropertyFilterFields";
import { useScorers } from "@/components/console/scorers/ScorerPickerProvider";
import { MAX_DIMENSIONS, type MetricForm, metricQuery, type SqlQuery } from "@/lib/contracts/query";
import { getMetric } from "@/lib/synthesis/metrics/catalog";
import type { TraceFilterBarFacets } from "@/lib/synthesis/traces/v2/filters";
import { type DashboardRange, rangeWindow } from "@/lib/views/dashboards/links";
import { formBucket, metricAsRql } from "@/lib/views/dashboards/metric-rql";
import {
  dimensionOfValue,
  dimensionValue,
  type PropertyBlock,
  propertyBlock,
  propertyOfValue,
  propertyOptions,
} from "@/lib/views/dashboards/properties";
import { chartChoices } from "@/lib/views/dashboards/sql-chart";
import {
  METRIC_CHARTS,
  type MetricChartKind,
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
 * The metric form over the RQL text that always runs: a dashboard widget's and an alert rule's. A
 * dropdown writes the text of its selection. An edit of the text makes it Custom: the Metric
 * dropdown says so, and Aggregation and Group by are off. Picking a metric again resets the text,
 * after a warning that keeps the text on cancel.
 */
export function MetricRqlFields({
  query,
  chart,
  bucket,
  groupBy,
  result,
  facets,
  window,
  onForm,
  onText,
}: {
  query: SqlQuery;
  /** The chart the text is written for: an alert's is a number. */
  chart: MetricChartKind;
  /** The bucket the text of a selection reads, for a line or a bar. */
  bucket: (form: MetricForm) => "hour" | "day";
  /** Whether the selection can group: an alert compares one number. */
  groupBy: boolean;
  /** The last result read: a refusal of RQL is said under the text. */
  result: WidgetResult | null;
  facets: TraceFilterBarFacets;
  /** What the query's window is, said under the text. */
  window?: string;
  /** A new selection; `fromCustom` when it replaced a text written by hand. */
  onForm: (form: MetricForm, fromCustom: boolean) => void;
  /** A text written by hand: Custom. */
  onText: (text: string) => void;
}) {
  const scorers = useScorers();
  const { projectId, choices } = usePropertyChoices();
  const [blocked, setBlocked] = useState<{ index: number; block: PropertyBlock } | null>(null);
  const { form } = query;
  const [last, setLast] = useState<MetricForm>(form ?? FIRST_FORM);
  const [reset, setReset] = useState<QueryChange | null>(null);
  const shown = form ?? last;
  const metric = getMetric(shown.measures[0].measure);
  const text = form ? metricAsRql(form, chart, bucket(form)) : query.text;

  const apply = (change: QueryChange) => {
    const next = changeForm(shown, change, scorers ?? []);
    setLast(next);
    onForm(groupBy ? next : { ...next, dimensions: [] }, !form);
  };
  const choose = (change: QueryChange) => {
    if (!form && change.measure) setReset(change);
    else apply(change);
  };
  const setDimension = (index: number, value: string) => {
    // A property that is not indexed is not picked: the tooltip says why, with the fix.
    const property = propertyOfValue(value);
    const block = property === undefined ? null : propertyBlock(projectId, choices, property);
    setBlocked(block ? { index, block } : null);
    if (block) return;
    choose({
      dimensions:
        value === NO_GROUP
          ? shown.dimensions.toSpliced(index, 1)
          : shown.dimensions.toSpliced(index, 1, dimensionOfValue(value)),
    });
  };
  const taken = shown.dimensions.map(dimensionValue);
  const groupable = groupBy && (metric?.dimensions.length ?? 0) > 0 && Boolean(form);
  const groupChoices = groupBy ? Math.min(MAX_DIMENSIONS, shown.dimensions.length + 1) : 0;

  return (
    <>
      <MetricFields query={shown} custom={!form} onChange={choose}>
        {Array.from({ length: groupChoices }, (_, index) => (
          <Field
            // biome-ignore lint/suspicious/noArrayIndexKey: a choice is its position.
            key={index}
            label={index === 0 ? "Group by" : "And by"}
            className="min-w-40 flex-1"
          >
            {(control) => {
              const own = taken[index];
              const others = taken.filter((value) => value !== own);
              return (
                <div className="flex flex-col">
                  <Select
                    {...control}
                    className="w-full"
                    disabled={!groupable}
                    options={[
                      { value: NO_GROUP, label: "No grouping" },
                      ...(metric?.dimensions ?? [])
                        .filter((value) => !others.includes(value))
                        .map((value) => ({ value, label: dimensionLabel(value) })),
                      // A property groups a measure a trace filter applies to.
                      ...(metric?.filterable ? propertyOptions(choices, others) : []),
                    ]}
                    value={own ?? NO_GROUP}
                    onValueChange={(value) => setDimension(index, String(value))}
                  />
                  {blocked?.index === index ? (
                    <PropertyBlockNote block={blocked.block} onClose={() => setBlocked(null)} />
                  ) : null}
                </div>
              );
            }}
          </Field>
        ))}
      </MetricFields>
      <SqlFields
        text={text}
        result={result}
        {...(window ? { window } : {})}
        onRun={(next) => {
          if (form && next.replace(/\s+/g, " ").trim() === text.replace(/\s+/g, " ").trim()) return;
          // An edited text is Custom: it no longer follows the dropdowns.
          if (form) setLast(form);
          onText(next);
        }}
      />
      {form && metric?.filterable ? (
        <>
          <QueryFilter
            filter={queryFilter(query)}
            facets={facets}
            onChange={(next) => apply({ filter: next(queryFilter(query)) })}
          />
          <PropertyFilterFields
            filter={queryFilter(query)}
            onChange={(next) => apply({ filter: next(queryFilter(query)) })}
          />
        </>
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

/**
 * A metric widget: the metric form over its RQL text, and the Chart control. The Chart control
 * offers what the rows can fill, with the reason for each one they cannot.
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
  const { query, chart } = widget;
  // A selection writes a text for each chart; a hand-written text fills what its rows fill.
  const fits = !query.form && result?.kind === "sql" ? chartChoices(result) : null;
  const off = METRIC_CHARTS.flatMap((value) =>
    fits?.[value] ? [`${CHART_LABELS[value]}: ${fits[value]}`] : [],
  );
  return (
    <>
      <MetricRqlFields
        query={query}
        chart={chart}
        bucket={(form) => (range ? formBucket(form, rangeWindow(range)) : (form.bucket ?? "hour"))}
        groupBy
        result={result}
        facets={facets}
        onForm={(form, fromCustom) =>
          onChange((current) => {
            // A table of no group is one row: a metric picked from a hand-written text starts as a line.
            const drawn =
              fromCustom && current.chart === "table" && form.dimensions.length === 0
                ? "line"
                : current.chart;
            return fitWidget({ ...current, chart: drawn, query: { ...query, form } });
          })
        }
        onText={(text) =>
          onChange((current) => fitWidget({ ...current, query: sqlWidgetQuery(text) }))
        }
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
    </>
  );
}
