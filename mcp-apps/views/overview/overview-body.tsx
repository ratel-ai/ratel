import { Button } from "@ratel/design-system/button";
import { EmptyState } from "@ratel/design-system/states";
import { ArrowUpRight, Inbox, LayoutDashboard, Puzzle } from "lucide-react";
import type { ReactNode } from "react";
import { BrokenWidgetBody } from "@/components/console/dashboards/WidgetCardBody";
import { GridCells } from "@/components/console/grid/GridCells";
import {
  type ItemFrame,
  itemBodies,
  itemFrames,
} from "@/components/console/home/focused/item-bodies";
import { widgetBodies } from "@/components/console/home/focused/widget-bodies";
import { GRID_GAP_PX, GRID_ROW_PX } from "@/lib/console/grid/layout";
import type { DashboardClusters } from "@/lib/views/dashboards/clusters";
import {
  isDashboardItem,
  type OverviewPlacement,
  placementTitle,
  visibleWidgets,
} from "@/lib/views/overview-layout/domain/layout";
import Link from "../../shell/shims/next-link";
import { ClustersTable } from "../dashboard/clusters-table";
import type { OverviewView } from "./overview";

type Bodies = Readonly<Record<string, ReactNode>>;

/**
 * The console's own widgets in view mode: the whole Overview in the person's places, or one widget
 * alone. Nothing here names a widget, so a later one needs no change.
 */
export function OverviewBody({
  view,
  openInConsole,
  drawn = bodiesOf,
}: {
  /** Null when the host did not pass the view's data. */
  view: OverviewView | null;
  openInConsole: (href: string) => void;
  /** Each widget's body, by name. */
  drawn?: (view: OverviewView) => Bodies;
}) {
  if (!view)
    return (
      <EmptyState
        icon={LayoutDashboard}
        title="The Overview cannot be drawn here"
        description="This host did not pass the view's data. The agent has the numbers."
      />
    );
  const { overview, widget } = view;
  const href = consoleHref(view);
  const bodies = drawn(view);
  const frames = itemFrames(overview);
  const cards = visibleWidgets(overview.layout).map((card) => ({
    ...card,
    ownHeight: isDashboardItem(card.id),
  }));
  const frameOf = (card: OverviewPlacement) => ({
    title: frames[card.id]?.title ?? titleOf(card),
    item: isDashboardItem(card.id) ? (frames[card.id] ?? null) : undefined,
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-xs text-fg-subtle">
          {widget === null ? null : (
            <>
              <span className="font-medium text-fg">
                {cards[0] ? frameOf(cards[0]).title : widget}
              </span>{" "}
              ·{" "}
            </>
          )}
          <span className={widget === null ? "font-medium text-fg" : undefined}>
            {overview.project.name}
          </span>{" "}
          · Last {overview.window} days
        </p>
        <Button variant="ghost" size="sm" onClick={() => openInConsole(href)}>
          Open in Ratel
          <ArrowUpRight aria-hidden className="size-3.5" />
        </Button>
      </div>
      {!overview.hasTelemetry ? (
        <EmptyState
          icon={Inbox}
          title="No data yet"
          description="The Overview shows once the project sends its first event."
        />
      ) : cards.length === 0 ? (
        <p className="text-sm text-fg-muted">The Overview has no widgets.</p>
      ) : widget === null ? (
        <GridCells cards={cards}>
          {(card) => (
            <Widget id={card.id} {...frameOf(card)} body={bodies[card.id]} className="h-full" />
          )}
        </GridCells>
      ) : (
        // Alone it is as tall as its content, and no less than on the page.
        <Widget
          id={widget}
          {...frameOf(cards[0])}
          body={bodies[widget]}
          height={heightOf(cards[0].h)}
        />
      )}
    </div>
  );
}

function Widget({
  id,
  title,
  item,
  body,
  className = "",
  height,
}: {
  id: string;
  title: string;
  /** A dashboard widget's; null for one that did not load. Absent for the Overview's own. */
  item?: ItemFrame | null;
  body: ReactNode;
  className?: string;
  height?: number;
}) {
  return (
    <section
      aria-label={title}
      data-overview-widget={id}
      // A chart of a dashboard fills what there is.
      style={item === undefined ? { minHeight: height } : { height }}
      className={`flex min-w-0 flex-col ${item === undefined ? "overflow-hidden" : "gap-3 p-4"} ${className}`}
    >
      {item === undefined ? (
        <h2 className="sr-only">{title}</h2>
      ) : (
        // The console's title row (components/console/grid/CardFrame.tsx).
        <div className="flex min-h-7 items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg" title={title}>
            {title}
          </h2>
          {item?.dashboard ? (
            <Link
              href={item.dashboard.href}
              className="max-w-1/2 truncate text-xs text-fg-subtle hover:text-fg hover:underline"
            >
              {item.dashboard.name}
            </Link>
          ) : null}
        </div>
      )}
      {item?.problem ? (
        <BrokenWidgetBody problem={item.problem} />
      ) : body ? (
        body
      ) : (
        <EmptyState
          icon={Puzzle}
          title="This widget cannot be drawn here"
          description="Open it in Ratel. The agent has its numbers."
        />
      )}
    </section>
  );
}

function bodiesOf(view: OverviewView): Bodies {
  const href = consoleHref(view);
  // No widget draws the last event's time.
  const { overview } = view;
  const clusters = Object.entries(overview.dashboards ?? {}).flatMap(([id, item]) =>
    // The console's drawing of them is the Intents map's (dashboard/clusters-table.tsx).
    item?.kind === "widget" && item.result?.kind === "clusters"
      ? [
          [
            id,
            <ClustersTable
              key={id}
              projectId={overview.project.id}
              result={item.result as DashboardClusters}
            />,
          ],
        ]
      : [],
  );
  return {
    ...widgetBodies(
      { ...overview, lastEventAt: null },
      view.linked,
      (peek) => `${href}${href.includes("?") ? "&" : "?"}peek=${peek}`,
    ),
    ...itemBodies(overview),
    ...Object.fromEntries(clusters),
  };
}

function consoleHref({ overview: { root, window, rangeParam } }: OverviewView): string {
  return window === 7 ? root : `${root}?range=${rangeParam}`;
}

function titleOf(card: OverviewPlacement): string {
  return placementTitle(card) ?? card.id;
}

function heightOf(rows: number): number {
  return rows * GRID_ROW_PX + (rows - 1) * GRID_GAP_PX;
}
