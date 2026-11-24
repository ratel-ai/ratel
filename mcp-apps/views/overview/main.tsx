"use client";

import { Button } from "@ratel/design-system/button";
import { EmptyState } from "@ratel/design-system/states";
import { ArrowUpRight, Inbox, LayoutDashboard } from "lucide-react";
import { GridCells } from "@/components/console/grid/GridCells";
import { widgetBodies } from "@/components/console/home/focused/widget-bodies";
import { WIDGET_TITLES } from "@/components/console/home/focused/widgets";
import type { FocusedOverviewData } from "@/lib/views/home/focused-load";
import { visibleWidgets } from "@/lib/views/overview-layout/domain/layout";
import { useRatelView } from "../../shell/bridge";
import { mountView } from "../../shell/mount";
import type { ToolSuccess } from "../../shell/state";
import { ViewFrame } from "../../shell/view-frame";
import view from "./bindings";
import { readOverviewView } from "./overview";

/**
 * The Overview: the console's own widgets, in the person's places, with the hidden ones absent.
 * Nothing is arranged here: an agent does that with change_overview_layout.
 */
function Overview({ result }: { result: ToolSuccess }) {
  const ratel = useRatelView();
  const read = readOverviewView(result);
  if (!read)
    return (
      <EmptyState
        icon={LayoutDashboard}
        title="The Overview cannot be drawn here"
        description="This host did not pass the view's data. The agent has the numbers."
      />
    );
  const { overview, linked } = read;
  const { root, window, rangeParam } = overview;
  const href = window === 7 ? root : `${root}?range=${rangeParam}`;
  const peekHref = (peek: string) => `${href}${href.includes("?") ? "&" : "?"}peek=${peek}`;
  // No widget draws the last event's time.
  const data: FocusedOverviewData = { ...overview, lastEventAt: null };
  const bodies = widgetBodies(data, linked, peekHref);
  const cards = visibleWidgets(overview.layout);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-xs text-fg-subtle">
          <span className="font-medium text-fg">{overview.project.name}</span> · Last {window} days
        </p>
        <Button variant="ghost" size="sm" onClick={() => ratel.openInConsole(href)}>
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
        <p className="text-sm text-fg-muted">Every widget is hidden.</p>
      ) : (
        <GridCells cards={cards}>
          {(card) => (
            <section
              aria-label={WIDGET_TITLES[card.id]}
              data-overview-widget={card.id}
              className="flex h-full min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-raised"
            >
              <h2 className="flex h-11 shrink-0 items-center px-4 text-sm font-semibold text-fg">
                {WIDGET_TITLES[card.id]}
              </h2>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">{bodies[card.id]?.body}</div>
            </section>
          )}
        </GridCells>
      )}
    </div>
  );
}

mountView(
  { name: "overview", bindings: view.bindings },
  <ViewFrame>{(result) => <Overview result={result} />}</ViewFrame>,
);
