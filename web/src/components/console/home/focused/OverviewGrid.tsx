"use client";

import { Button } from "@ratel/design-system/button";
import { Skeleton } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo } from "react";
import { BrokenWidgetBody } from "@/components/console/dashboards/WidgetCardBody";
import { CardFrame, focusToolbar } from "@/components/console/grid/CardFrame";
import { CardGrid } from "@/components/console/grid/CardGrid";
import { focusSoon } from "@/components/console/grid/EditBar";
import { ADD_ID, EDIT_ID, EditButton } from "@/components/console/home/focused/EditMode";
import { scrollToReveal, widgetToReveal } from "@/components/console/home/focused/edit-mode";
import type { ItemFrames } from "@/components/console/home/focused/item-bodies";
import { useOverviewLayout } from "@/components/console/home/focused/OverviewLayout";
import type { WidgetBodies } from "@/components/console/home/focused/widget-bodies";
import { placeWords } from "@/lib/console/grid/edit-mode";
import { GRID_GAP_PX, type GridStep } from "@/lib/console/grid/layout";
import {
  isDashboardItem,
  type OverviewItemId,
  type OverviewPlacement,
  placementTitle,
  stepChange,
  visibleWidgets,
  widgetMinimum,
} from "@/lib/views/overview-layout/domain/layout";

/** The person's widgets, in their places. A widget just added is a skeleton until the server has read it. */
export function OverviewGrid({
  bodies,
  items,
}: {
  /** Null for a widget that the server did not read, because it was removed. */
  bodies: WidgetBodies;
  /** The dashboard widgets. */
  items: ItemFrames;
}) {
  const { layout, editing, editable, change, undo } = useOverviewLayout();
  useReveal(bodies, items);
  const cards = useMemo(
    () =>
      visibleWidgets(layout).map((widget) => ({
        ...widget,
        min: widgetMinimum(widget.id),
        ownHeight: isDashboardItem(widget.id),
      })),
    [layout],
  );
  if (cards.length === 0) return <NoWidgets />;

  const titleOf = (card: OverviewPlacement) => items[card.id]?.title ?? placementTitle(card);

  function step(card: OverviewPlacement, name: GridStep) {
    const widget = card.id;
    const next = stepChange(layout, widget, name);
    if (!next) return;
    const place = next.places.find(({ id }) => id === widget);
    change(next, place ? placeWords(titleOf(card), place) : undefined);
    // The cards' order in the page follows their places, which can take the focus away.
    requestAnimationFrame(() => focusToolbar(widget));
  }

  function remove(card: OverviewPlacement) {
    const { id: widget, w, h } = card;
    const title = titleOf(card);
    const next = cards[cards.findIndex(({ id }) => id === widget) + 1];
    const removal = change({ kind: "remove", widget }, `${title} removed`);
    toast({
      title: `${title} is removed`,
      action: {
        label: "Undo",
        onClick: () =>
          undo({ change: removal, otherwise: { kind: "add", widget, source: { title, w, h } } }),
      },
    });
    if (next) requestAnimationFrame(() => focusToolbar(next.id));
    else focusSoon(ADD_ID);
  }

  return (
    <CardGrid
      cards={cards}
      onArrange={
        editing
          ? (items, taken) =>
              change({
                kind: "arrange",
                widget: taken,
                places: items.map(({ id, x, y, w, h }) => ({
                  id,
                  x,
                  y,
                  w,
                  h,
                })),
              })
          : undefined
      }
    >
      {(card: OverviewPlacement) => {
        const title = titleOf(card);
        const item = items[card.id];
        return (
          <CardFrame
            id={card.id}
            title={title}
            titleRow={
              isDashboardItem(card.id) ? (
                <SourceLink dashboard={item?.dashboard ?? null} />
              ) : undefined
            }
            edit={
              editing
                ? {
                    can: (name) => stepChange(layout, card.id, name) !== null,
                    step: (name) => step(card, name),
                    remove: () => remove(card),
                  }
                : null
            }
          >
            {item?.problem ? (
              <BrokenWidgetBody
                problem={item.problem}
                onRemove={editable ? () => remove(card) : undefined}
              />
            ) : (
              (bodies[card.id] ?? <Waiting title={title} />)
            )}
          </CardFrame>
        );
      }}
    </CardGrid>
  );
}

/** Scrolls to what the Add widget dialog added, once it is saved and the server has drawn it. */
function useReveal(bodies: WidgetBodies, items: ItemFrames) {
  const { layout, added, setAdded, saving, adding } = useOverviewLayout();
  const widget = widgetToReveal(added, layout);
  const drawn = widget !== null && Boolean(bodies[widget] ?? items[widget]);
  useEffect(() => {
    if (added.length === 0 || saving || adding || (widget && !drawn)) return;
    const frame = requestAnimationFrame(() => {
      if (widget) reveal(widget);
      setAdded([]);
    });
    return () => cancelAnimationFrame(frame);
  }, [added, setAdded, saving, adding, widget, drawn]);
}

function reveal(id: OverviewItemId) {
  const card = document.querySelector(`[data-card="${CSS.escape(id)}"]`);
  if (!card) return;
  const bar = document.querySelector("[data-edit-bar]");
  const top = scrollToReveal(card.getBoundingClientRect(), {
    // The widget's toolbar floats over the gap above it.
    top: (bar?.getBoundingClientRect().bottom ?? 0) + GRID_GAP_PX,
    bottom: window.innerHeight,
  });
  if (top === 0) return;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollBy({ top, behavior: still ? "instant" : "smooth" });
}

function NoWidgets() {
  const { editing, editable, setAdding } = useOverviewLayout();
  return (
    <p
      className="flex min-h-7 flex-wrap items-center gap-3 text-sm text-fg-muted"
      data-overview-empty=""
    >
      The Overview has no widgets.
      {editing ? (
        <Button size="sm" aria-haspopup="dialog" onClick={() => setAdding(true)}>
          <Plus aria-hidden />
          Add widget
        </Button>
      ) : editable ? (
        <EditButton id={`${EDIT_ID}-empty`} />
      ) : null}
    </p>
  );
}

/** Where a dashboard widget comes from, and where it is edited. */
function SourceLink({ dashboard }: { dashboard: { name: string; href: string } | null }) {
  if (!dashboard) return null;
  return (
    <Link
      href={dashboard.href}
      className="max-w-1/2 truncate rounded-sm text-xs text-fg-subtle outline-none hover:text-fg hover:underline focus-visible:ring-2 focus-visible:ring-focus"
      title={`Open the dashboard ${dashboard.name}`}
    >
      {dashboard.name}
    </Link>
  );
}

function Waiting({ title }: { title: string }) {
  return (
    <div role="status" className="h-full min-h-32 p-4">
      <span className="sr-only">Loading {title}</span>
      <Skeleton className="size-full min-h-24" />
    </div>
  );
}
