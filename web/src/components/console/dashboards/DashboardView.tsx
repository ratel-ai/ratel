"use client";

import { Button, IconButton } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { ConfirmDialog } from "@ratel/design-system/dialog";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@ratel/design-system/menu";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { EmptyState } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { ChartColumn, Copy, Download, Ellipsis, House, Pencil, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, startTransition, useCallback, useOptimistic, useState } from "react";
import { exportDashboardAction } from "@/app/(console)/project/[projectId]/dashboards/actions";
import { addDashboardWidgetToOverview } from "@/app/(console)/project/[projectId]/overview-actions";
import { type CardEdit, CardFrame, focusToolbar } from "@/components/console/grid/CardFrame";
import { CardGrid } from "@/components/console/grid/CardGrid";
import { EditModeBar, focusSoon, InertHeader } from "@/components/console/grid/EditBar";
import { useScorers } from "@/components/console/scorers/ScorerPickerProvider";
import { useTraceNavigation } from "@/components/console/traces/navigation";
import { TraceFilterBar } from "@/components/console/traces/TraceFilterBar";
import { type TimeWindow, TimeWindowMenu } from "@/components/console/traces/TracesHeader";
import { placeWords } from "@/lib/console/grid/edit-mode";
import { type GridItem, type GridStep, stepped } from "@/lib/console/grid/layout";
import { projectRoot } from "@/lib/console/navigation";
import { metricOffered } from "@/lib/synthesis/metrics/catalog";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import {
  filterChips,
  type TraceFilterBarFacets,
  withRangePreset,
} from "@/lib/synthesis/traces/v2/filters";
import { withSelectedDays } from "@/lib/synthesis/traces/v2/volume";
import { DEFAULT_TRACE_RANGE } from "@/lib/synthesis/traces/view";
import {
  barChange,
  barSearch,
  DASHBOARD_FILTER_FIELDS,
  sameDefaults,
  withoutOwnView,
} from "@/lib/views/dashboards/filters";
import { cardOf, layoutsOf, MIN_WIDGET } from "@/lib/views/dashboards/layout";
import {
  ADD_SCORER_PARAM,
  dashboardsHref,
  searchFromTraceFilter,
} from "@/lib/views/dashboards/links";
import { isBroken } from "@/lib/views/dashboards/stored-widget";
import type {
  BrokenWidget,
  DashboardDefaults,
  DashboardFilters,
  DashboardWidget,
  GridPosition,
  Widget,
  WidgetInput,
  WidgetResult,
} from "@/lib/views/dashboards/types";
import {
  isFilterable,
  queryFilter,
  queryMetric,
  queryScorerId,
  widgetName,
} from "@/lib/views/dashboards/widget";
import { explorePanelHref } from "@/lib/views/explore/links";
import { NameDialog } from "./NameDialog";
import { useDashboardAction } from "./use-dashboard-action";
import { BrokenWidgetBody, WidgetCardBody } from "./WidgetCardBody";
import { WidgetEditor } from "./WidgetEditor";
import { WidgetLinkItems } from "./WidgetLinkItems";

const EDIT_ID = "dashboard-edit";
const DONE_ID = "dashboard-done";
const ADD_ID = "dashboard-add-widget";

/** One dashboard: its widgets on the shared card grid, over the time window in the URL. */
export function DashboardView({
  projectId,
  dashboard,
  filters,
  problem,
  widgets,
  facets,
  timeWindow,
  alerts,
  draft,
  overview = false,
  startEditing = false,
}: {
  projectId: string;
  dashboard: { id: string; name: string; defaults: DashboardDefaults };
  /** What every widget is narrowed by now. */
  filters: DashboardFilters;
  /** Why the filters of the address cannot be shown, or null. */
  problem: string | null;
  widgets: readonly { widget: DashboardWidget; result: WidgetResult | null }[];
  facets: TraceFilterBarFacets;
  timeWindow: TimeWindow;
  /** Alerts are on: a widget can start one. */
  alerts: boolean;
  /** A widget to start adding as the page opens, from a scorer's page. */
  draft: WidgetInput | null;
  /** The Overview takes widgets of dashboards (`focusedConsole`). */
  overview?: boolean;
  /** Draws edit mode at first, in a test. */
  startEditing?: boolean;
}) {
  const router = useRouter();
  // Null while scorers are off.
  const scorers = useScorers();
  const { search, pending, go } = useTraceNavigation();
  const { change, saving } = useDashboardAction(projectId);
  // The editor's widget outlives `editing`, so the dialog keeps its content as it closes.
  const [editing, setEditing] = useState(draft !== null);
  const [start, setStart] = useState(draft);
  const [edited, setEdited] = useState<{ id: string; widget: WidgetInput } | null>(null);
  const [filtersRefused, setFiltersRefused] = useState<string | null>(null);
  // In this page only: a reload is view mode.
  const [arranging, setArranging] = useState(startEditing);
  const [pinning, setPinning] = useState(false);
  const [said, setSaid] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const dashboardId = dashboard.id;
  const { defaults } = dashboard;
  // Fixed days are not a default: the saved range stays.
  const [placed, showLayouts] = useOptimistic(
    widgets.map(({ widget }) => widget),
    (current, layouts: Record<string, GridPosition>) =>
      current.map((widget) => ({ ...widget, layout: layouts[widget.id] ?? widget.layout })),
  );
  const resultOf = new Map(widgets.map(({ widget, result }) => [widget.id, result]));
  const shown: DashboardDefaults = {
    filters,
    range: shownRange(timeWindow.preset, defaults.range),
  };

  function openEditor(stored: Widget | null) {
    if (stored) {
      const { id, layout: _, missingScorer: __, ...widget } = stored;
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

  /** The new places show at once; a refused one goes back. */
  function place(items: readonly GridItem[]) {
    const layouts = layoutsOf(items);
    startTransition(async () => {
      showLayouts(layouts);
      await change({ action: "save-layout", dashboardId, layouts });
    });
  }

  const leave = useCallback(() => {
    setArranging(false);
    setSaid("Edit mode is off.");
    focusSoon(EDIT_ID);
  }, []);

  /** A card's controls in edit mode, or null. */
  function cardEdit(widget: DashboardWidget, title: string, items?: ReactNode): CardEdit | null {
    if (!arranging) return null;
    const to = (step: GridStep) => stepped(cards, widget.id, step, MIN_WIDGET);
    return {
      can: (step) => to(step) !== null,
      step: (step) => {
        const next = to(step);
        const at = next?.find(({ id }) => id === widget.id);
        if (!next || !at) return;
        place(next);
        setSaid(placeWords(title, at));
        // The cards' order in the page follows their places, which can take the focus away.
        requestAnimationFrame(() => focusToolbar(widget.id));
      },
      remove: () => void (isBroken(widget) ? removeBroken(widget) : remove(widget)),
      items,
    };
  }

  /** On the person's own Overview; nothing of the dashboard changes. */
  async function addToOverview(widgetId: string, title: string) {
    setPinning(true);
    const added = await addDashboardWidgetToOverview(projectId, dashboardId, widgetId).catch(
      () => null,
    );
    setPinning(false);
    if (!added?.ok) {
      toast({
        title: added?.message ?? "Could not change the Overview. Try again.",
        tone: "danger",
      });
      return;
    }
    toast({
      title: added.changed
        ? `${title} added to your Overview`
        : `${title} is on your Overview already`,
      tone: "success",
      action: {
        label: "Open Overview",
        onClick: () => router.push(projectRoot(projectId)),
      },
    });
  }

  async function remove({ id, layout, missingScorer, ...widget }: Widget) {
    if (!(await change({ action: "remove-widget", dashboardId, widgetId: id }))) return;
    toast({
      title: `${widgetName(widget)} removed`,
      action: {
        label: "Undo",
        onClick: () =>
          void change({ action: "add-widget", dashboardId, widget, layout, missingScorer }),
      },
    });
  }

  async function removeBroken({ id, title }: BrokenWidget) {
    if (await change({ action: "remove-widget", dashboardId, widgetId: id }))
      toast({ title: `${title} removed` });
  }

  async function exportAs(to: "file" | "copy") {
    try {
      const read = await exportDashboardAction(projectId, dashboardId);
      if (!read.ok) {
        toast({ title: read.error, tone: "danger" });
        return;
      }
      if (read.leftOut > 0)
        toast({
          title: `${read.leftOut} broken widget${read.leftOut === 1 ? " is" : "s are"} not in the export`,
        });
      const json = `${JSON.stringify(read.document, null, 2)}\n`;
      if (to === "file") downloadJson(`${slugOf(read.document.name)}.dashboard.json`, json);
      else {
        await navigator.clipboard.writeText(json);
        toast({ title: "Dashboard JSON copied" });
      }
    } catch {
      toast({ title: "Could not export the dashboard. Try again.", tone: "danger" });
    }
  }

  function available(widget: Widget) {
    const metric = queryMetric(widget.query);
    return !metric || metricOffered(metric, { customMonitoring: scorers !== null });
  }

  const cards = placed.map((widget) => ({ ...cardOf(widget), min: MIN_WIDGET, ownHeight: true }));

  return (
    <Page>
      <EditModeBar
        editing={arranging}
        label="Edit dashboard"
        note="Everyone in the project sees the changes."
        doneId={DONE_ID}
        onLeave={leave}
      >
        <Button
          id={ADD_ID}
          aria-label="Add widget"
          aria-haspopup="dialog"
          size="sm"
          onClick={() => openEditor(null)}
        >
          <Plus aria-hidden />
          <span className="max-sm:hidden">Add widget</span>
        </Button>
      </EditModeBar>
      <InertHeader editing={arranging}>
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
                  render={
                    <IconButton label="Dashboard actions" size="icon-sm" icon={<Ellipsis />} />
                  }
                />
                <MenuContent align="end">
                  <MenuItem icon={<Pencil />} onClick={() => setRenaming(true)}>
                    Rename
                  </MenuItem>
                  <MenuItem icon={<Download />} onClick={() => void exportAs("file")}>
                    Export JSON
                  </MenuItem>
                  <MenuItem icon={<Copy />} onClick={() => void exportAs("copy")}>
                    Copy JSON
                  </MenuItem>
                  <MenuItem icon={<Trash2 />} tone="danger" onClick={() => setDeleting(true)}>
                    Delete dashboard
                  </MenuItem>
                </MenuContent>
              </Menu>
              {widgets.length > 0 ? (
                <Button
                  id={EDIT_ID}
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setArranging(true);
                    setSaid("Edit mode. Add, move, resize or remove widgets.");
                    focusSoon(DONE_ID);
                  }}
                >
                  <Pencil aria-hidden />
                  Edit
                </Button>
              ) : null}
            </>
          }
        />
      </InertHeader>
      <PageBody wide>
        <TraceFilterBar
          tab="rollup"
          entities
          searchable={false}
          only={DASHBOARD_FILTER_FIELDS}
          pending={pending}
          facets={facets}
          search={barSearch(search, defaults.filters)}
          onSearchChange={(next) => {
            // Together with each widget's own they are one filter of the traces.
            const change = barChange(next, {
              search,
              saved: defaults.filters,
              queries: widgets.flatMap(({ widget }) => (isBroken(widget) ? [] : [widget.query])),
            });
            setFiltersRefused(change.refused);
            if (!change.refused) go(change.go);
          }}
          end={
            sameDefaults(shown, defaults) ? null : (
              <>
                <Button variant="ghost" size="sm" onClick={() => go(withoutOwnView)}>
                  Reset
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={saving}
                  onClick={async () => {
                    if (await change({ action: "save-defaults", dashboardId, defaults: shown }))
                      toast({ title: "Saved as the dashboard's default", tone: "success" });
                  }}
                >
                  Save as default
                </Button>
              </>
            )
          }
        />
        {filtersRefused ? (
          <p role="alert" className="text-xs text-danger">
            {filtersRefused}
          </p>
        ) : null}
        {problem ? (
          <EmptyState
            icon={ChartColumn}
            title="These filters cannot be shown"
            description={problem}
            action={
              <Button variant="secondary" size="sm" onClick={() => go(withoutOwnView)}>
                Reset
              </Button>
            }
          />
        ) : widgets.length === 0 ? (
          <EmptyState
            icon={ChartColumn}
            title="No widgets yet"
            description="Add a chart of any metric, a flow, a step flow, a funnel, a cluster view or a map."
            action={
              <Button variant="primary" size="sm" onClick={() => openEditor(null)}>
                <Plus className="size-3.5" aria-hidden />
                Add widget
              </Button>
            }
          />
        ) : (
          <div className={cn("transition-opacity duration-160", pending && "opacity-60")}>
            <CardGrid cards={cards} onArrange={arranging ? (items) => place(items) : undefined}>
              {({ widget }) => {
                if (isBroken(widget))
                  return (
                    <CardFrame
                      id={widget.id}
                      title={widget.title}
                      titleRow={null}
                      edit={cardEdit(widget, widget.title)}
                    >
                      <BrokenWidgetBody
                        problem={widget.problem}
                        disabled={saving}
                        onRemove={() => void removeBroken(widget)}
                      />
                    </CardFrame>
                  );
                const title = widgetName(widget);
                const editItem = (
                  <MenuItem
                    icon={<Pencil />}
                    disabled={!available(widget)}
                    onClick={() => openEditor(widget)}
                  >
                    Edit widget
                  </MenuItem>
                );
                return (
                  <CardFrame
                    id={widget.id}
                    title={title}
                    edit={cardEdit(widget, title, editItem)}
                    titleRow={
                      <>
                        {Object.keys(filters).length > 0 &&
                        !isFilterable(widget.query) &&
                        widget.query.kind !== "clusters" &&
                        // The page's filter applies to RQL text when it runs.
                        widget.query.kind !== "sql" ? (
                          <p className="shrink-0 text-xs text-fg-subtle">Not filtered</p>
                        ) : null}
                        <FilterNote
                          filter={queryFilter(widget.query)}
                          scorer={
                            scorers?.find(({ id }) => id === queryScorerId(widget.query))?.name
                          }
                        />
                        <Menu>
                          <MenuTrigger
                            render={
                              <IconButton
                                label={`${title} actions`}
                                size="icon-sm"
                                icon={<Ellipsis />}
                              />
                            }
                          />
                          <MenuContent align="end">
                            {editItem}
                            {overview ? (
                              <MenuItem
                                icon={<House />}
                                disabled={pinning}
                                onClick={() => void addToOverview(widget.id, title)}
                              >
                                Add to Overview
                              </MenuItem>
                            ) : null}
                            <MenuSeparator />
                            <WidgetLinkItems
                              projectId={projectId}
                              widget={widget}
                              filters={filters}
                              range={timeWindow}
                              exploreHref={
                                available(widget) && !widget.missingScorer
                                  ? explorePanelHref(projectId, widget, {
                                      filters,
                                      range: timeWindow,
                                    })
                                  : null
                              }
                              alerts={alerts && available(widget) && !widget.missingScorer}
                            />
                          </MenuContent>
                        </Menu>
                      </>
                    }
                  >
                    <WidgetCardBody
                      projectId={projectId}
                      widget={widget}
                      result={resultOf.get(widget.id) ?? null}
                      range={timeWindow}
                      filters={filters}
                      available={available(widget)}
                      missingScorer={widget.missingScorer}
                    />
                  </CardFrame>
                );
              }}
            </CardGrid>
          </div>
        )}
      </PageBody>
      <WidgetEditor
        open={editing}
        onOpenChange={onEditorOpenChange}
        projectId={projectId}
        initial={edited?.widget ?? null}
        start={start}
        facets={facets}
        range={timeWindow}
        filters={filters}
        saving={saving}
        onSave={(widget) => void save(widget)}
      />
      <span className="sr-only" aria-live="polite">
        {said}
      </span>
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

/** The default range reads as no choice of its own. */
function shownRange(
  preset: TimeWindow["preset"],
  saved: DashboardDefaults["range"],
): DashboardDefaults["range"] {
  if (preset === "custom") return saved;
  return saved === null && preset === DEFAULT_TRACE_RANGE ? null : preset;
}

/** A filtered widget says so: its number is not the whole project's. */
function FilterNote({ filter, scorer }: { filter: TraceFilter; scorer?: string }) {
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

function slugOf(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "dashboard"
  );
}

function downloadJson(name: string, json: string) {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
