import { Button } from "@ratel/design-system/button";
import { EmptyState } from "@ratel/design-system/states";
import { ArrowUpRight, Inbox, LayoutDashboard, Puzzle } from "lucide-react";
import type { ReactNode } from "react";
import { GridCells } from "@/components/console/grid/GridCells";
import { widgetBodies } from "@/components/console/home/focused/widget-bodies";
import { WIDGETS } from "@/components/console/home/focused/widgets";
import { GRID_GAP_PX, GRID_ROW_PX } from "@/lib/console/grid/layout";
import { visibleWidgets } from "@/lib/views/overview-layout/domain/layout";
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
  const cards = visibleWidgets(overview.layout);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-xs text-fg-subtle">
          {widget === null ? null : (
            <>
              <span className="font-medium text-fg">{titleOf(widget)}</span> ·{" "}
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
          {({ id }) => <Widget id={id} body={bodies[id]} className="h-full overflow-hidden" />}
        </GridCells>
      ) : (
        // Alone it is as tall as its content, and no less than on the page.
        <Widget id={widget} body={bodies[widget]} minHeight={heightOf(cards[0].h)} />
      )}
    </div>
  );
}

function Widget({
  id,
  body,
  className = "",
  minHeight,
}: {
  id: string;
  body: ReactNode;
  className?: string;
  minHeight?: number;
}) {
  return (
    <section
      aria-label={titleOf(id)}
      data-overview-widget={id}
      style={{ minHeight }}
      className={`flex min-w-0 flex-col ${className}`}
    >
      <h2 className="sr-only">{titleOf(id)}</h2>
      {body ?? (
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
  return widgetBodies(
    { ...view.overview, lastEventAt: null },
    view.linked,
    (peek) => `${href}${href.includes("?") ? "&" : "?"}peek=${peek}`,
  );
}

function consoleHref({ overview: { root, window, rangeParam } }: OverviewView): string {
  return window === 7 ? root : `${root}?range=${rangeParam}`;
}

function titleOf(id: string): string {
  return (WIDGETS as Readonly<Record<string, { title: string } | undefined>>)[id]?.title ?? id;
}

function heightOf(rows: number): number {
  return rows * GRID_ROW_PX + (rows - 1) * GRID_GAP_PX;
}
