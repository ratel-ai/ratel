"use client";

import { Button } from "@ratel/design-system/button";
import { Skeleton } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { Plus } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { CardGrid } from "@/components/console/grid/CardGrid";
import { ADD_ID, EDIT_ID, EditButton, focusSoon } from "@/components/console/home/focused/EditMode";
import { useOverviewLayout } from "@/components/console/home/focused/OverviewLayout";
import {
  focusToolbar,
  type StepName,
  WidgetCard,
} from "@/components/console/home/focused/WidgetCard";
import { WIDGETS } from "@/components/console/home/focused/widgets";
import {
  type OverviewPlacement,
  type OverviewWidgetId,
  stepChange,
  visibleWidgets,
  widgetMinimum,
} from "@/lib/views/overview-layout/domain/layout";

/** The person's widgets, in their places. A widget just added is a skeleton until the server has read it. */
export function OverviewGrid({
  bodies,
}: {
  /** Null for a widget that the server did not read, because it was removed. */
  bodies: Readonly<Record<OverviewWidgetId, ReactNode>>;
}) {
  const { layout, editing, change } = useOverviewLayout();
  const cards = useMemo(
    () => visibleWidgets(layout).map((widget) => ({ ...widget, min: widgetMinimum(widget.id) })),
    [layout],
  );
  if (cards.length === 0) return <NoWidgets />;

  function step(widget: OverviewWidgetId, name: StepName) {
    const next = stepChange(layout, widget, name);
    if (!next) return;
    const place = next.places.find(({ id }) => id === widget);
    change(
      next,
      place
        ? `${WIDGETS[widget].title}: row ${place.y + 1}, column ${place.x + 1}, ${place.w} wide, ${place.h} high`
        : undefined,
    );
    // The cards' order in the page follows their places, which can take the focus away.
    requestAnimationFrame(() => focusToolbar(widget));
  }

  function remove(widget: OverviewWidgetId) {
    const { title } = WIDGETS[widget];
    const next = cards[cards.findIndex(({ id }) => id === widget) + 1];
    change({ kind: "remove", widget }, `${title} removed`);
    toast({
      title: `${title} is removed`,
      action: {
        label: "Undo",
        onClick: () => change({ kind: "add", widget }, `${title} added`),
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
          ? (items) =>
              change({
                kind: "arrange",
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
        const { title } = WIDGETS[card.id];
        return (
          <WidgetCard
            id={card.id}
            title={title}
            edit={
              editing
                ? {
                    can: (name) => stepChange(layout, card.id, name) !== null,
                    step: (name) => step(card.id, name),
                    remove: () => remove(card.id),
                  }
                : null
            }
          >
            {bodies[card.id] ?? <Waiting title={title} />}
          </WidgetCard>
        );
      }}
    </CardGrid>
  );
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

function Waiting({ title }: { title: string }) {
  return (
    <div role="status" className="h-full min-h-32 p-4">
      <span className="sr-only">Loading {title}</span>
      <Skeleton className="size-full min-h-24" />
    </div>
  );
}
