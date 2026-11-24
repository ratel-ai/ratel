"use client";

import { Button, IconButton } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { ConfirmDialog } from "@ratel/design-system/dialog";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLinkItem,
  MenuSeparator,
  MenuTrigger,
} from "@ratel/design-system/menu";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { EmptyState } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import {
  ArrowDown,
  ArrowUp,
  Bell,
  ChartColumn,
  Ellipsis,
  ListTree,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTraceNavigation } from "@/components/console/traces/navigation";
import { type TimeWindow, TimeWindowMenu } from "@/components/console/traces/TracesHeader";
import { getMetric, metricOffered } from "@/lib/synthesis/metrics/catalog";
import type { MetricResult } from "@/lib/synthesis/metrics/query";
import {
  filterChips,
  type TraceFilterBarFacets,
  withRangePreset,
} from "@/lib/synthesis/traces/v2/filters";
import { withSelectedDays } from "@/lib/synthesis/traces/v2/volume";
import { newAlertHref } from "@/lib/views/alerts/links";
import {
  ADD_SCORER_PARAM,
  dashboardsHref,
  searchFromTraceFilter,
  widgetTracesHref,
} from "@/lib/views/dashboards/links";
import type { ScorerOption, Widget, WidgetInput, WidgetWidth } from "@/lib/views/dashboards/types";
import { widgetName } from "@/lib/views/dashboards/widget";
import { NameDialog } from "./NameDialog";
import { useDashboardAction } from "./use-dashboard-action";
import { WidgetBody } from "./WidgetBody";
import { WidgetEditor } from "./WidgetEditor";

const WIDTH_CLASS: Readonly<Record<WidgetWidth, string>> = {
  third: "lg:col-span-2",
  half: "lg:col-span-3",
  full: "lg:col-span-6",
};

/** One dashboard: its widgets in order, over the time window in the URL. */
export function DashboardView({
  projectId,
  dashboard,
  widgets,
  facets,
  timeWindow,
  scorers,
  alerts,
  draft,
}: {
  projectId: string;
  dashboard: { id: string; name: string };
  widgets: readonly { widget: Widget; result: MetricResult | null }[];
  facets: TraceFilterBarFacets;
  timeWindow: TimeWindow;
  /** The project's scorers; null while scorers are off. */
  scorers: readonly ScorerOption[] | null;
  /** Alerts are on: a widget can start one. */
  alerts: boolean;
  /** A widget to start adding as the page opens, from a scorer's page. */
  draft: WidgetInput | null;
}) {
  const router = useRouter();
  const { pending, go } = useTraceNavigation();
  const { change, saving } = useDashboardAction(projectId);
  // The editor's widget outlives `editing`, so the dialog keeps its content as it closes.
  const [editing, setEditing] = useState(draft !== null);
  const [start, setStart] = useState(draft);
  const [edited, setEdited] = useState<{ id: string; widget: WidgetInput } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const dashboardId = dashboard.id;

  function openEditor(stored: Widget | null) {
    if (stored) {
      const { id, ...widget } = stored;
      setEdited({ id, widget });
    } else {
      setEdited(null);
    }
    setEditing(true);
  }

  /** The draft is taken once: the address and the next "Add widget" start clean. */
  function onEditorOpenChange(open: boolean) {
    setEditing(open);
    if (open || !start) return;
    setStart(null);
    const url = new URL(window.location.href);
    url.searchParams.delete(ADD_SCORER_PARAM);
    window.history.replaceState(null, "", url);
  }

  async function save(widget: WidgetInput) {
    const saved = await change(
      edited
        ? { action: "edit-widget", dashboardId, widgetId: edited.id, widget }
        : { action: "add-widget", dashboardId, widget },
    );
    if (saved) onEditorOpenChange(false);
  }

  async function remove({ id, ...widget }: Widget, index: number) {
    if (!(await change({ action: "remove-widget", dashboardId, widgetId: id }))) return;
    toast({
      title: `${widgetName(widget)} removed`,
      action: {
        label: "Undo",
        onClick: () => void change({ action: "add-widget", dashboardId, widget, index }),
      },
    });
  }

  function available(widget: Widget) {
    const metric = getMetric(widget.metric);
    return !metric || metricOffered(metric, { scorers: scorers !== null });
  }

  const addWidget = (
    <Button variant="primary" size="sm" onClick={() => openEditor(null)}>
      <Plus className="size-3.5" aria-hidden />
      Add widget
    </Button>
  );

  return (
    <Page>
      <PageHeader
        title={dashboard.name}
        crumbs={[{ label: "Dashboards", href: dashboardsHref(projectId) }]}
        actions={
          <>
            <TimeWindowMenu
              timeWindow={timeWindow}
              onToday={() =>
                go((current) =>
                  withSelectedDays(current, { from: timeWindow.today, to: timeWindow.today }),
                )
              }
              onSelect={(preset) => go((current) => withRangePreset(current, preset))}
            />
            <Menu>
              <MenuTrigger
                render={<IconButton label="Dashboard actions" size="icon-sm" icon={<Ellipsis />} />}
              />
              <MenuContent align="end">
                <MenuItem icon={<Pencil />} onClick={() => setRenaming(true)}>
                  Rename
                </MenuItem>
                <MenuItem icon={<Trash2 />} tone="danger" onClick={() => setDeleting(true)}>
                  Delete dashboard
                </MenuItem>
              </MenuContent>
            </Menu>
            {widgets.length > 0 ? addWidget : null}
          </>
        }
      />
      <PageBody wide>
        {widgets.length === 0 ? (
          <EmptyState
            icon={ChartColumn}
            title="No widgets yet"
            description="Add a chart, a number or a table of any metric."
            action={addWidget}
          />
        ) : (
          <div
            aria-busy={pending || undefined}
            className={cn(
              "grid grid-cols-1 gap-4 transition-opacity duration-160 lg:grid-cols-6",
              pending && "opacity-60",
            )}
          >
            {widgets.map(({ widget, result }, index) => (
              <section
                key={widget.id}
                aria-labelledby={`widget-${widget.id}`}
                className={cn(
                  "flex min-w-0 flex-col gap-3 rounded-lg border border-line p-4",
                  WIDTH_CLASS[widget.width],
                )}
              >
                <div className="flex items-center gap-2">
                  <h2
                    id={`widget-${widget.id}`}
                    className="min-w-0 flex-1 truncate text-sm font-semibold text-fg"
                  >
                    {widgetName(widget)}
                  </h2>
                  <FilterNote
                    filter={widget.filter}
                    scorer={scorers?.find(({ id }) => id === widget.scorerId)?.name}
                  />
                  <Menu>
                    <MenuTrigger
                      render={
                        <IconButton
                          label={`${widgetName(widget)} actions`}
                          size="icon-sm"
                          icon={<Ellipsis />}
                        />
                      }
                    />
                    <MenuContent align="end">
                      <MenuItem
                        icon={<Pencil />}
                        disabled={!available(widget)}
                        onClick={() => openEditor(widget)}
                      >
                        Edit
                      </MenuItem>
                      <MenuItem
                        icon={<ArrowUp />}
                        disabled={saving || index === 0}
                        onClick={() =>
                          void change({
                            action: "move-widget",
                            dashboardId,
                            widgetId: widget.id,
                            direction: "up",
                          })
                        }
                      >
                        Move up
                      </MenuItem>
                      <MenuItem
                        icon={<ArrowDown />}
                        disabled={saving || index === widgets.length - 1}
                        onClick={() =>
                          void change({
                            action: "move-widget",
                            dashboardId,
                            widgetId: widget.id,
                            direction: "down",
                          })
                        }
                      >
                        Move down
                      </MenuItem>
                      <MenuLinkItem
                        icon={<ListTree />}
                        render={
                          <Link href={widgetTracesHref(projectId, widget.filter, timeWindow)} />
                        }
                      >
                        View traces
                      </MenuLinkItem>
                      {alerts && available(widget) ? (
                        <MenuLinkItem
                          icon={<Bell />}
                          render={<Link href={newAlertHref(projectId, widget)} />}
                        >
                          Create alert
                        </MenuLinkItem>
                      ) : null}
                      <MenuSeparator />
                      <MenuItem
                        icon={<Trash2 />}
                        tone="danger"
                        disabled={saving}
                        onClick={() => void remove(widget, index)}
                      >
                        Remove
                      </MenuItem>
                    </MenuContent>
                  </Menu>
                </div>
                <WidgetBody
                  projectId={projectId}
                  widget={widget}
                  result={result}
                  range={timeWindow}
                  available={available(widget)}
                />
              </section>
            ))}
          </div>
        )}
      </PageBody>
      <WidgetEditor
        open={editing}
        onOpenChange={onEditorOpenChange}
        projectId={projectId}
        initial={edited?.widget ?? null}
        start={start}
        scorers={scorers}
        facets={facets}
        range={timeWindow}
        saving={saving}
        onSave={(widget) => void save(widget)}
      />
      <NameDialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename dashboard"
        submitLabel="Rename"
        initial={dashboard.name}
        saving={saving}
        onSubmit={async (name) => {
          if (await change({ action: "rename", dashboardId, name })) setRenaming(false);
        }}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${dashboard.name}?`}
        description="The dashboard and its widgets are gone for everyone in the project. Traces stay."
        confirmLabel="Delete dashboard"
        requireText={dashboard.name}
        onConfirm={async () => {
          if (await change({ action: "delete", dashboardId }))
            router.push(dashboardsHref(projectId));
        }}
      />
    </Page>
  );
}

/** A filtered widget says so: its number is not the whole project's. */
function FilterNote({ filter, scorer }: { filter: WidgetInput["filter"]; scorer?: string }) {
  const chips = filterChips("rollup", searchFromTraceFilter(filter), { entities: true });
  const parts = chips.map(({ field, value }) => `${field} ${value}`);
  if (scorer) parts.unshift(scorer);
  if (parts.length === 0) return null;
  const text = parts.join(", ");
  return (
    <p className="max-w-1/2 truncate text-xs text-fg-subtle" title={text}>
      {text}
    </p>
  );
}
