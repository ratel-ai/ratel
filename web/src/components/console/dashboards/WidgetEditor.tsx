"use client";

import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { Dialog, DialogClose, DialogContent } from "@ratel/design-system/dialog";
import { Field, Input } from "@ratel/design-system/input";
import { Select } from "@ratel/design-system/select";
import { Skeleton } from "@ratel/design-system/states";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { useEffect, useState } from "react";
import {
  previewWidgetAction,
  type WidgetPreview,
} from "@/app/(console)/project/[projectId]/dashboards/actions";
import { TraceFilterBar } from "@/components/console/traces/TraceFilterBar";
import {
  getMetric,
  type MetricAggregation,
  type MetricGroupBy,
  type MetricId,
  offeredMetrics,
} from "@/lib/synthesis/metrics/catalog";
import {
  type TraceFilterBarFacets,
  traceFilterFromSearch,
} from "@/lib/synthesis/traces/v2/filters";
import { type DashboardRange, searchFromTraceFilter } from "@/lib/views/dashboards/links";
import {
  MAX_WIDGET_TITLE,
  type ScorerOption,
  WIDGET_CHARTS,
  type WidgetInput,
  type WidgetWidth,
} from "@/lib/views/dashboards/types";
import {
  aggregationLabel,
  CHART_LABELS,
  fitWidget,
  groupByLabel,
  scorersOfMetric,
  widgetName,
} from "@/lib/views/dashboards/widget";
import { WidgetBody } from "./WidgetBody";

const NO_GROUP = "none";
const ALL_SCORERS = "all";
const PREVIEW_DELAY_MS = 200;
const WIDTHS: readonly { value: WidgetWidth; label: string }[] = [
  { value: "third", label: "Third" },
  { value: "half", label: "Half" },
  { value: "full", label: "Full" },
];
const NEW_WIDGET: WidgetInput = {
  title: "",
  metric: "trace_count",
  aggregation: "count",
  groupBy: null,
  filter: {},
  chart: "line",
  width: "half",
};

/** Add or edit a widget: one dialog, with the widget drawn live as it changes. */
export function WidgetEditor({
  open,
  onOpenChange,
  projectId,
  initial,
  start,
  scorers,
  facets,
  range,
  saving,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** The widget being edited; a new one without it. */
  initial: WidgetInput | null;
  /** What a new one starts from, instead of the default. */
  start: WidgetInput | null;
  /** The project's scorers; null while scorers are off, and their metrics are then not offered. */
  scorers: readonly ScorerOption[] | null;
  facets: TraceFilterBarFacets;
  range: DashboardRange;
  saving: boolean;
  onSave: (widget: WidgetInput) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={initial ? "Edit widget" : "Add widget"}
        className="top-[4vh] max-h-[92dvh] w-[min(44rem,calc(100vw-2rem))]"
      >
        <EditorForm
          projectId={projectId}
          initial={initial ?? start ?? NEW_WIDGET}
          scorers={scorers}
          submitLabel={initial ? "Save widget" : "Add widget"}
          facets={facets}
          range={range}
          saving={saving}
          onSave={onSave}
        />
      </DialogContent>
    </Dialog>
  );
}

/** Inside the popup, so every open starts from the stored widget. */
function EditorForm({
  projectId,
  initial,
  scorers,
  submitLabel,
  facets,
  range,
  saving,
  onSave,
}: {
  projectId: string;
  initial: WidgetInput;
  scorers: readonly ScorerOption[] | null;
  submitLabel: string;
  facets: TraceFilterBarFacets;
  range: DashboardRange;
  saving: boolean;
  onSave: (widget: WidgetInput) => void;
}) {
  const [widget, setWidget] = useState<WidgetInput>(initial);
  const { preview, pending } = usePreview(projectId, widget, range);
  const metric = getMetric(widget.metric);
  if (!metric) return null;
  // Every change lands on a widget the rules allow, so Save never has to refuse one.
  const set = (change: Partial<WidgetInput>) =>
    setWidget((current) => {
      const next = fitWidget({ ...current, ...change });
      // A pass rate has no 1 to 5 scorer, and the average no pass or fail one.
      const fits = scorersOfMetric(next.metric, scorers ?? []).some(
        ({ id }) => id === next.scorerId,
      );
      return fits ? next : { ...next, scorerId: undefined };
    });
  const groupable = metric.groupBys.length > 0;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(widget);
      }}
    >
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
              value={widget.metric}
              onValueChange={(value) => set({ metric: value as MetricId })}
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
              value={widget.aggregation}
              onValueChange={(value) => set({ aggregation: value as MetricAggregation })}
            />
          )}
        </Field>
        <Field label="Group by" className="min-w-40 flex-1">
          {(control) => (
            <Select
              {...control}
              className="w-full"
              disabled={!groupable || widget.chart === "number"}
              options={[
                // A table lists groups, so it always has one.
                ...(widget.chart === "table" ? [] : [{ value: NO_GROUP, label: "No grouping" }]),
                ...metric.groupBys.map((value) => ({ value, label: groupByLabel(value) })),
              ]}
              value={widget.groupBy ?? NO_GROUP}
              onValueChange={(value) =>
                set({ groupBy: value === NO_GROUP ? null : (value as MetricGroupBy) })
              }
            />
          )}
        </Field>
        {metric.source === "scores" ? (
          <Field label="Scorer" className="min-w-40 flex-1">
            {(control) => (
              <Select
                {...control}
                className="w-full"
                options={[
                  { value: ALL_SCORERS, label: "All scorers" },
                  ...scorersOfMetric(widget.metric, scorers ?? []).map(({ id, name }) => ({
                    value: id,
                    label: name,
                  })),
                ]}
                value={widget.scorerId ?? ALL_SCORERS}
                onValueChange={(value) =>
                  set({ scorerId: value === ALL_SCORERS ? undefined : String(value) })
                }
              />
            )}
          </Field>
        ) : null}
      </div>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <Choice label="Chart">
          <SegmentedControl
            label="Chart"
            options={WIDGET_CHARTS.map((value) => ({
              value,
              label: CHART_LABELS[value],
              disabled: value === "table" && !groupable,
            }))}
            value={widget.chart}
            onValueChange={(chart) => set({ chart })}
          />
        </Choice>
        <Choice label="Width">
          <SegmentedControl
            label="Width"
            options={WIDTHS}
            value={widget.width}
            onValueChange={(width) => set({ width })}
          />
        </Choice>
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
      {metric.filterable ? (
        <Choice label="Filter">
          <TraceFilterBar
            tab="rollup"
            entities
            searchable={false}
            pending={false}
            facets={facets}
            search={searchFromTraceFilter(widget.filter)}
            onSearchChange={(next) =>
              setWidget((current) => {
                const search = searchFromTraceFilter(current.filter);
                return {
                  ...current,
                  filter: traceFilterFromSearch(typeof next === "function" ? next(search) : next, {
                    entities: true,
                  }),
                };
              })
            }
          />
        </Choice>
      ) : null}
      <section
        aria-label="Preview"
        aria-busy={pending || undefined}
        className={cn(
          "min-h-64 rounded-lg border border-line bg-app p-4 transition-opacity duration-160",
          pending && preview && "opacity-60",
        )}
      >
        <h3 className="mb-3 truncate text-sm font-semibold text-fg">{widgetName(widget)}</h3>
        {preview ? (
          preview.ok ? (
            <WidgetBody
              projectId={projectId}
              widget={preview.widget}
              result={preview.result}
              range={range}
            />
          ) : (
            <p role="status" className="text-sm text-danger">
              {preview.error}
            </p>
          )
        ) : (
          <Skeleton className="h-40 w-full" />
        )}
      </section>
      <div className="flex justify-end gap-2">
        <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
        <Button type="submit" variant="primary" loading={saving}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** A labelled control that is not one input: a segmented control, the filter bar. */
function Choice({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span aria-hidden className="text-xs font-medium text-fg-muted">
        {label}
      </span>
      {children}
    </div>
  );
}

/** The result with the widget it was read for: a chart never draws another widget's numbers. */
type Preview =
  | (Extract<WidgetPreview, { ok: true }> & { widget: WidgetInput })
  | Extract<WidgetPreview, { ok: false }>;

/** The widget's numbers as it changes. The last ones stay, dimmed, until the next arrive. */
function usePreview(projectId: string, widget: WidgetInput, range: DashboardRange) {
  const [preview, setPreview] = useState<{ key: string; value: Preview } | null>(null);
  const { preset, from, to } = range;
  // The title and the width change no number.
  const key = JSON.stringify([{ ...widget, title: "", width: "half" }, preset, from, to]);
  useEffect(() => {
    let stale = false;
    const [asked] = JSON.parse(key) as [WidgetInput];
    const timer = setTimeout(async () => {
      let value: Preview;
      try {
        const read = await previewWidgetAction(projectId, asked, { preset, from, to });
        value = read.ok ? { ...read, widget: asked } : read;
      } catch {
        value = { ok: false, error: "The numbers could not be read." };
      }
      if (!stale) setPreview({ key, value });
    }, PREVIEW_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [projectId, key, preset, from, to]);
  return { preview: preview?.value ?? null, pending: preview?.key !== key };
}
