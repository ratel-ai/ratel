"use client";

import { Button } from "@ratel/design-system/button";
import { Input } from "@ratel/design-system/input";
import { Skeleton } from "@ratel/design-system/states";
import { Check, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  type DashboardWidgetsRead,
  useOverviewLayout,
} from "@/components/console/home/focused/OverviewLayout";
import {
  type DashboardItemId,
  type DashboardItemSource,
  dashboardItemId,
  MAX_DASHBOARD_ITEMS,
  roomForDashboardItem,
} from "@/lib/views/overview-layout/domain/layout";

/** The widgets of the project's dashboards, each as a reference to its dashboard. */
export function DashboardWidgetPicker({
  read,
  onAdd,
}: {
  read: () => Promise<DashboardWidgetsRead>;
  onAdd: (id: DashboardItemId, source: DashboardItemSource) => void;
}) {
  const { layout } = useOverviewLayout();
  const [offer, setOffer] = useState<DashboardWidgetsRead | null>(null);
  // A save refreshes the page and brings a new `read`: the list stays while it runs again.
  const load = useCallback(async () => {
    setOffer(
      await read().catch(() => ({ ok: false as const, message: "The server did not answer." })),
    );
  }, [read]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section
      aria-label="Dashboard widgets"
      className="flex flex-col gap-3 border-t border-line pt-4"
    >
      <h3 className="text-sm font-semibold text-fg">Dashboard widgets</h3>
      {offer === null ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">Loading the dashboard widgets</span>
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : !offer.ok ? (
        <div className="flex items-center gap-3">
          <p role="alert" className="min-w-0 flex-1 text-ui text-danger">
            {offer.message}
          </p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setOffer(null);
              void load();
            }}
          >
            Try again
          </Button>
        </div>
      ) : offer.dashboards.length === 0 ? (
        <p className="text-ui text-fg-muted">No dashboard has a widget yet.</p>
      ) : (
        <DashboardWidgetList
          dashboards={offer.dashboards}
          there={new Set(layout.map(({ id }) => id))}
          room={roomForDashboardItem(layout)}
          onAdd={onAdd}
        />
      )}
    </section>
  );
}

/** Drawn apart from the read, for a test. */
export function DashboardWidgetList({
  dashboards,
  there,
  room,
  onAdd,
}: {
  dashboards: Extract<DashboardWidgetsRead, { ok: true }>["dashboards"];
  /** The entries of the layout. */
  there: ReadonlySet<string>;
  room: boolean;
  onAdd: (id: DashboardItemId, source: DashboardItemSource) => void;
}) {
  const [search, setSearch] = useState("");
  const words = search.trim().toLowerCase();
  const found = dashboards
    .map(({ widgets, ...dashboard }) => ({
      ...dashboard,
      widgets: widgets.filter(({ title }) =>
        `${title} ${dashboard.name}`.toLowerCase().includes(words),
      ),
    }))
    .filter(({ widgets }) => widgets.length > 0);
  return (
    <>
      <Input
        type="search"
        aria-label="Search dashboard widgets"
        placeholder="Search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {room ? null : (
        <p className="text-xs text-fg-muted">
          An Overview can have {MAX_DASHBOARD_ITEMS} dashboard widgets. Remove one first.
        </p>
      )}
      {found.length === 0 ? (
        <p className="text-ui text-fg-muted">No widget has that name.</p>
      ) : null}
      {found.map(({ id: dashboardId, name, widgets }) => (
        <div key={dashboardId}>
          <h4 className="truncate text-xs text-fg-subtle">{name}</h4>
          <ul className="divide-y divide-line">
            {widgets.map(({ id: widgetId, title, w, h }) => {
              const id = dashboardItemId(dashboardId, widgetId);
              const added = there.has(id);
              return (
                <li key={id} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-ui text-fg" title={title}>
                    {title}
                  </span>
                  <Button
                    size="sm"
                    aria-label={added ? `${title} is added` : `Add ${title} of ${name}`}
                    variant={added ? "ghost" : "secondary"}
                    disabled={added || !room}
                    focusableWhenDisabled
                    onClick={() => onAdd(id, { title, w, h })}
                  >
                    {added ? <Check aria-hidden /> : <Plus aria-hidden />}
                    {added ? "Added" : "Add"}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}
