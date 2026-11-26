"use client";

import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { Dialog, DialogClose, DialogContent } from "@ratel/design-system/dialog";
import { Skeleton } from "@ratel/design-system/states";
import { useState } from "react";
import { metricQuery } from "@/lib/contracts/query";
import type { TraceFilterBarFacets } from "@/lib/synthesis/traces/v2/filters";
import { filtersProblem } from "@/lib/views/dashboards/filters";
import type { DashboardRange } from "@/lib/views/dashboards/links";
import type { DashboardFilters, WidgetInput } from "@/lib/views/dashboards/types";
import { widgetName } from "@/lib/views/dashboards/widget";
import { useWidgetPreview } from "./use-widget-preview";
import { WidgetBody } from "./WidgetBody";
import { WidgetFields } from "./WidgetFields";

const NEW_WIDGET: WidgetInput = {
  title: "",
  query: metricQuery("trace_count", "count"),
  chart: "line",
};

/** Add or edit a widget: one dialog, with the widget drawn live as it changes. */
export function WidgetEditor({
  open,
  onOpenChange,
  projectId,
  initial,
  start,
  facets,
  range,
  filters,
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
  facets: TraceFilterBarFacets;
  range: DashboardRange;
  /** The dashboard's: the preview shows what the widget will. */
  filters: DashboardFilters;
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
          submitLabel={initial ? "Save widget" : "Add widget"}
          facets={facets}
          range={range}
          filters={filters}
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
  submitLabel,
  facets,
  range,
  filters,
  saving,
  onSave,
}: {
  projectId: string;
  initial: WidgetInput;
  submitLabel: string;
  facets: TraceFilterBarFacets;
  range: DashboardRange;
  /** The dashboard's: the preview shows what the widget will. */
  filters: DashboardFilters;
  saving: boolean;
  onSave: (widget: WidgetInput) => void;
}) {
  const [widget, setWidget] = useState<WidgetInput>(initial);
  const [refused, setRefused] = useState<string | null>(null);
  const { preview, pending } = useWidgetPreview(projectId, widget, range, filters);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(widget);
      }}
    >
      <WidgetFields
        widget={widget}
        onChange={(next) => {
          const changed = next(widget);
          const problem = filtersProblem([changed.query], filters);
          setRefused(problem);
          if (!problem) setWidget(changed);
        }}
        refused={refused ? { field: "filter", message: refused } : null}
        facets={facets}
        range={range}
        result={preview?.ok ? preview.result : null}
      />
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
              filters={filters}
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
