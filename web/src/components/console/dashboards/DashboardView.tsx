"use client";

import { Button, IconButton } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { ConfirmDialog } from "@ratel/design-system/dialog";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@ratel/design-system/menu";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { EmptyState } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import {
  ChartColumn,
  Copy,
  Download,
  Ellipsis,
  House,
  Maximize2,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type ReactNode,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
} from "react";
import { exportDashboardAction } from "@/app/(console)/project/[projectId]/dashboards/actions";
import { addDashboardWidgetToOverview } from "@/app/(console)/project/[projectId]/overview-actions";
import { type CardEdit, CardFrame, focusToolbar } from "@/components/console/grid/CardFrame";
import { CardGrid } from "@/components/console/grid/CardGrid";
import { EditModeBar, focusSoon, InertHeader } from "@/components/console/grid/EditBar";
import { PropertyFilterFields } from "@/components/console/properties/PropertyFilterFields";
import { useScorers } from "@/components/console/scorers/ScorerPickerProvider";
import { useTraceNavigation } from "@/components/console/traces/navigation";
import { TraceFilterBar } from "@/components/console/traces/TraceFilterBar";
import { type TimeWindow, TimeWindowMenu } from "@/components/console/traces/TracesHeader";
import { placeWords } from "@/lib/console/grid/edit-mode";
import { type GridItem, type GridStep, stepped } from "@/lib/console/grid/layout";
import { projectRoot } from "@/lib/console/navigation";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import {
  filterChips,
  type TraceFilterBarFacets,
  withRangePreset,
} from "@/lib/synthesis/traces/v2/filters";
import { withSelectedDays } from "@/lib/synthesis/traces/v2/volume";
import { DEFAULT_TRACE_RANGE } from "@/lib/synthesis/traces/view";
import { BUILT_BY_ASK_PARAM } from "@/lib/views/ask/outcome";
import {
  collapseStep,
  expandedOf,
  expandsCard,
  NEW_WIDGET_ID,
  withExpanded,
} from "@/lib/views/dashboards/expanded";
import {
  barChange,
  barSearch,
  DASHBOARD_FILTER_FIELDS,
  sameDefaults,
  withBarFilter,
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
  NEW_SQL_TEXT,
  queryFilter,
  queryScorerId,
  sqlWidgetQuery,
  widgetName,
} from "@/lib/views/dashboards/widget";
import { explorePanelHref } from "@/lib/views/explore/links";
import { ExpandedWidget } from "./ExpandedWidget";
import { NameDialog } from "./NameDialog";
import { NewWidgetDialog } from "./NewWidgetDialog";
import { useDashboardAction } from "./use-dashboard-action";
import { previewKey } from "./use-widget-preview";
import { BrokenWidgetBody, WidgetCardBody } from "./WidgetCardBody";
import { WidgetLinkItems } from "./WidgetLinkItems";

const EDIT_ID = "dashboard-edit";
const DONE_ID = "dashboard-done";
const ADD_ID = "dashboard-add-widget";
/** A new widget is a metric widget: a table of the newest traces, until a metric is picked. */
const NEW_WIDGET: WidgetInput = { title: "", query: sqlWidgetQuery(NEW_SQL_TEXT), chart: "table" };

/** One dashboard: its widgets on the shared card grid, over the time window in the URL. */
export function DashboardView({
  projectId,
  dashboard,
  filters,
  problem,
  widgets,
  facets,
  timeWindow,
  draft,
  ask = false,
  leftOut = [],
  overview = false,
  readOnly = false,
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
  /** A widget to start adding as the page opens, from a scorer's page. */
  draft: WidgetInput | null;
  /** This deployment can draft widgets from words: the new widget dialog has its ask field. */
  ask?: boolean;
  /** The widgets that the ask which built this dashboard left out, with their reason. */
  leftOut?: readonly { title: string; reason: string }[];
  /** The Overview takes widgets of dashboards (`focusedConsole`). */
  overview?: boolean;
  /** A support session: a widget opens with its properties, and nothing saves. */
  readOnly?: boolean;
  /** Draws edit mode at first, in a test. */
  startEditing?: boolean;
}) {
  const router = useRouter();
  const scorers = useScorers();
  const { pathname, search, pending, go } = useTraceNavigation();
  const { change, saving } = useDashboardAction(projectId);
  // A scorer's page starts a new widget from it: taken once, so the next new one starts clean.
  const [start, setStart] = useState(draft);
  const [showLeftOut, setShowLeftOut] = useState(leftOut.length > 0);
  // The new widget dialog: open from any state of the page, never in a support session.
  const [adding, setAdding] = useState(draft !== null && !readOnly);
  // The address this page pushed to expand a widget: Close goes Back to the grid while it is current.
  const pushed = useRef<string | null>(null);
  // The card to give the focus to once the grid is back.
  const focusAfter = useRef<{ id: string | null } | null>(null);
  const pressedAt = useRef<{ x: number; y: number } | null>(null);
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

  /** A change of the page filter: in the address, unless a widget cannot take it. */
  function changeBar(next: string | ((bar: string) => string)) {
    // Together with each widget's own they are one filter of the traces.
    const change = barChange(next, {
      search,
      saved: defaults.filters,
      queries: widgets.flatMap(({ widget }) => (isBroken(widget) ? [] : [widget.query])),
    });
    setFiltersRefused(change.refused);
    if (!change.refused) go(change.go);
  }

  // The expanded widget is in the address: a link opens it, and Back closes it.
  const expandedId = expandedOf(search);
  const expandedStored =
    expandedId && expandedId !== NEW_WIDGET_ID
      ? placed.find((widget): widget is Widget => widget.id === expandedId && !isBroken(widget))
      : undefined;
  const expanded: { id: string; widget: WidgetInput } | null = expandedStored
    ? { id: expandedStored.id, widget: inputOf(expandedStored) }
    : null;

  // The numbers the page came with, for the open widget: one Map while they stay the same, so its
  // preview does not start again at each render.
  const servedKey =
    expandedStored && expanded ? previewKey(expanded.widget, timeWindow, filters) : null;
  const servedResult = expandedStored ? (resultOf.get(expandedStored.id) ?? null) : null;
  const served = useMemo(
    () => (servedKey === null ? undefined : new Map([[servedKey, servedResult]])),
    [servedKey, servedResult],
  );

  // A draft from a scorer's page opens in the new widget dialog; its parameter leaves the address.
  // An older link to a new widget opens the dialog too.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const legacy = expandedOf(window.location.search) === NEW_WIDGET_ID;
    if (!draft && !legacy) return;
    params.delete(ADD_SCORER_PARAM);
    if (legacy && !readOnly) setAdding(true);
    window.history.replaceState(null, "", `${pathname}${withExpanded(`?${params}`, null)}`);
  }, [draft, pathname, readOnly]);

  /** Opens the new widget dialog. */
  function add() {
    if (!readOnly) setAdding(true);
  }

  /** Expands a widget in place, or a new one: a new entry of the history, the page as it is. */
  function expand(id: string) {
    const href = `${pathname}${withExpanded(window.location.search, id)}`;
    window.history.pushState(null, "", href);
    pushed.current = href;
  }

  /** Back to the grid, with the focus on the card it was. */
  function collapse() {
    focusAfter.current = { id: expanded?.id ?? null };
    setStart(null);
    const current = `${window.location.pathname}${window.location.search}`;
    const step = collapseStep(current, pushed.current);
    pushed.current = null;
    if (step === "back") window.history.back();
    else
      window.history.replaceState(
        null,
        "",
        `${pathname}${withExpanded(window.location.search, null)}`,
      );
  }

  // Once the grid is back, the focus goes to the card that was open, or to Add widget.
  useEffect(() => {
    if (expanded || !focusAfter.current) return;
    const { id } = focusAfter.current;
    focusAfter.current = null;
    const target =
      (id ? document.querySelector<HTMLElement>(`[data-card="${CSS.escape(id)}"] button`) : null) ??
      document.getElementById(ADD_ID) ??
      document.querySelector<HTMLElement>("[data-add-widget]");
    target?.focus();
  });

  async function save(widget: WidgetInput) {
    const id = expanded?.id;
    if (!id) return;
    if (await change({ action: "edit-widget", dashboardId, widgetId: id, widget })) collapse();
  }

  /** The dialog's widget, at the end of the grid. */
  async function addWidget(widget: WidgetInput): Promise<boolean> {
    const added = await change({ action: "add-widget", dashboardId, widget });
    if (added) setStart(null);
    return Boolean(added);
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
        {readOnly ? null : (
          <Button id={ADD_ID} aria-label="Add widget" size="sm" onClick={add}>
            <Plus aria-hidden />
            <span className="max-sm:hidden">Widget</span>
          </Button>
        )}
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
              {readOnly ? null : (
                <Button data-add-widget="" aria-label="Add widget" size="sm" onClick={add}>
                  <Plus aria-hidden />
                  Widget
                </Button>
              )}
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
          onSearchChange={changeBar}
          more={
            <PropertyFilterFields
              filter={filters}
              chips={false}
              onChange={(edit) => changeBar((bar) => withBarFilter(bar, edit))}
            />
          }
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
        {showLeftOut ? (
          <LeftOutNote
            leftOut={leftOut}
            onDismiss={() => {
              setShowLeftOut(false);
              const params = new URLSearchParams(window.location.search);
              params.delete(BUILT_BY_ASK_PARAM);
              const rest = params.toString();
              window.history.replaceState(null, "", `${pathname}${rest ? `?${rest}` : ""}`);
            }}
          />
        ) : null}
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
        ) : expanded ? (
          <ExpandedWidget
            // A new open starts from the stored widget.
            key={expanded.id}
            projectId={projectId}
            initial={expanded.widget}
            served={served}
            facets={facets}
            range={timeWindow}
            filters={filters}
            saving={saving}
            readOnly={readOnly}
            onSave={(widget) => void save(widget)}
            onClose={collapse}
          />
        ) : widgets.length === 0 ? (
          <EmptyState
            icon={ChartColumn}
            title="No widgets yet"
            description="Add a chart of any metric, a flow, a step flow, a funnel, a cluster view or a map."
            action={
              // A support session reads the dashboard and adds nothing.
              readOnly ? undefined : (
                <Button variant="primary" size="sm" onClick={add}>
                  <Plus className="size-3.5" aria-hidden />
                  Add widget
                </Button>
              )
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
                  <MenuItem icon={<Maximize2 />} onClick={() => expand(widget.id)}>
                    {readOnly ? "Open widget" : "Edit widget"}
                  </MenuItem>
                );
                return (
                  // A click on the card opens it; a drag, a link or a menu in it keeps its own.
                  // biome-ignore lint/a11y/noStaticElementInteractions: the keyboard opens it from the card's menu.
                  // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard opens it from the card's menu.
                  <div
                    className={cn("h-full", !arranging && "cursor-pointer")}
                    onPointerDown={(event) => {
                      pressedAt.current = { x: event.clientX, y: event.clientY };
                    }}
                    onClick={(event) => {
                      const from = pressedAt.current;
                      pressedAt.current = null;
                      if (arranging || !from) return;
                      const target = event.target as Element;
                      if (expandsCard(from, { x: event.clientX, y: event.clientY }, target))
                        expand(widget.id);
                    }}
                  >
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
                                  !widget.missingScorer
                                    ? explorePanelHref(projectId, widget, {
                                        filters,
                                        range: timeWindow,
                                      })
                                    : null
                                }
                                alerts={!widget.missingScorer}
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
                        missingScorer={widget.missingScorer}
                      />
                    </CardFrame>
                  </div>
                );
              }}
            </CardGrid>
          </div>
        )}
      </PageBody>
      <span className="sr-only" aria-live="polite">
        {said}
      </span>
      <NewWidgetDialog
        open={adding}
        onOpenChange={(open) => {
          setAdding(open);
          if (!open) setStart(null);
        }}
        projectId={projectId}
        dashboardId={dashboardId}
        start={start ?? NEW_WIDGET}
        startChosen={start !== null}
        ask={ask}
        facets={facets}
        range={timeWindow}
        filters={filters}
        saving={saving}
        onSave={addWidget}
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

/** The widgets the ask that built this dashboard left out, each with its reason, until dismissed. */
function LeftOutNote({
  leftOut,
  onDismiss,
}: {
  leftOut: readonly { title: string; reason: string }[];
  onDismiss: () => void;
}) {
  return (
    <section
      aria-label="Widgets left out"
      className="flex items-start gap-3 rounded-lg border border-line bg-app p-3 text-sm"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-fg">
          Built from your words. {leftOut.length} drafted widget
          {leftOut.length === 1 ? " was" : "s were"} left out: the RQL check refused{" "}
          {leftOut.length === 1 ? "it" : "them"}.
        </p>
        <ul className="flex flex-col gap-0.5 text-xs text-fg-muted">
          {leftOut.map(({ title, reason }) => (
            <li key={`${title}\n${reason}`}>
              <span className="text-fg">{title || "Untitled"}</span>: {reason}
            </li>
          ))}
        </ul>
      </div>
      <IconButton label="Dismiss" size="icon-sm" icon={<X />} onClick={onDismiss} />
    </section>
  );
}

/** What a stored widget is, without its place on the grid. */
function inputOf({ id: _, layout: __, missingScorer: ___, ...widget }: Widget): WidgetInput {
  return widget;
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
