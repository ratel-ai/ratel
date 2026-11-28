"use client";

import { Button, IconButton } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { ConfirmDialog } from "@ratel/design-system/dialog";
import { Skeleton } from "@ratel/design-system/states";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TraceFilterBarFacets } from "@/lib/synthesis/traces/v2/filters";
import { hasUnsavedChanges } from "@/lib/views/dashboards/expanded";
import { filtersProblem } from "@/lib/views/dashboards/filters";
import type { DashboardRange } from "@/lib/views/dashboards/links";
import type { DashboardFilters, WidgetInput } from "@/lib/views/dashboards/types";
import { widgetName } from "@/lib/views/dashboards/widget";
import { type ServedResults, useWidgetPreview } from "./use-widget-preview";
import { WidgetCardBody } from "./WidgetCardBody";
import { WidgetFields } from "./WidgetFields";

/**
 * One widget expanded in place of the grid: the chart large on one side, its properties on the
 * other. An edit saves with no dialog. Cancel, Escape and Close collapse it, after a warning when
 * an edit would be lost. A reader who cannot change the dashboard sees the properties only.
 */
export function ExpandedWidget({
  projectId,
  initial,
  isNew,
  served,
  facets,
  range,
  filters,
  saving,
  readOnly,
  onSave,
  onClose,
}: {
  projectId: string;
  /** The widget as stored, or what a new one starts from. */
  initial: WidgetInput;
  isNew: boolean;
  /** The numbers the page came with: an unchanged widget draws them without a new read. */
  served?: ServedResults;
  facets: TraceFilterBarFacets;
  range: DashboardRange;
  /** The page's: the chart shows what the card will. */
  filters: DashboardFilters;
  saving: boolean;
  /** A support session reads the dashboard and changes nothing. */
  readOnly: boolean;
  onSave: (widget: WidgetInput) => void;
  onClose: () => void;
}) {
  const [widget, setWidget] = useState<WidgetInput>(initial);
  const [refused, setRefused] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const { preview, pending } = useWidgetPreview(projectId, widget, range, filters, served);
  const dirty = !readOnly && hasUnsavedChanges(initial, widget);
  const title = widgetName(widget);

  // The focus goes to the widget as it opens: a keyboard reads on from its title.
  useEffect(() => heading.current?.focus(), []);

  const close = () => {
    if (dirty) setLeaving(true);
    else onClose();
  };

  return (
    <section
      aria-labelledby="expanded-widget-title"
      className="flex flex-col gap-4 rounded-lg border border-line bg-app p-4"
      onKeyDown={(event) => {
        // A menu or a dialog inside takes its own Escape first.
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        close();
      }}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!readOnly) onSave(widget);
        }}
      >
        <div className="flex items-center gap-2">
          <h2
            id="expanded-widget-title"
            ref={heading}
            tabIndex={-1}
            className="min-w-0 flex-1 truncate text-base font-semibold text-fg outline-none focus:outline-none focus-visible:outline-none"
          >
            {isNew ? `New widget: ${title}` : title}
          </h2>
          {readOnly ? (
            <p className="text-xs text-fg-subtle">Read only in a support session</p>
          ) : (
            <>
              <Button type="button" variant="ghost" size="sm" onClick={close}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                loading={saving}
                disabled={!isNew && !dirty}
              >
                {isNew ? "Add widget" : "Save"}
              </Button>
            </>
          )}
          <IconButton
            type="button"
            label="Close widget"
            size="icon-sm"
            icon={<X />}
            onClick={close}
          />
        </div>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(20rem,2fr)]">
          <section
            aria-label="Chart"
            aria-busy={pending || undefined}
            className={cn(
              "@container flex h-96 min-w-0 flex-col transition-opacity duration-160 lg:h-[30rem]",
              pending && preview && "opacity-60",
            )}
          >
            {preview ? (
              preview.ok ? (
                <WidgetCardBody
                  projectId={projectId}
                  widget={preview.widget}
                  result={preview.result}
                  range={range}
                  filters={filters}
                  expanded
                />
              ) : (
                <p role="status" className="text-sm text-danger">
                  {preview.error}
                </p>
              )
            ) : (
              <Skeleton className="h-80 w-full" />
            )}
          </section>
          <fieldset
            aria-label="Properties"
            disabled={readOnly}
            className="flex min-w-0 flex-col gap-4"
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
          </fieldset>
        </div>
      </form>
      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        title="Discard your changes?"
        description="The widget closes and your edits to it are lost. The dashboard stays as it was."
        confirmLabel="Discard changes"
        onConfirm={() => {
          setLeaving(false);
          onClose();
        }}
      />
    </section>
  );
}
