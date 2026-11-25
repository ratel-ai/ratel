"use client";

import { Skeleton } from "@ratel/design-system/states";
import { toast } from "@ratel/design-system/toast";
import { type ReactNode, useMemo } from "react";
import { CardGrid } from "@/components/console/grid/CardGrid";
import { CUSTOMIZE_ID, CustomizeButton } from "@/components/console/home/focused/Customize";
import { useOverviewLayout } from "@/components/console/home/focused/OverviewLayout";
import { menuId, type StepName, WidgetCard } from "@/components/console/home/focused/WidgetCard";
import { WIDGET_TITLES } from "@/components/console/home/focused/widgets";
import {
  type OverviewPlacement,
  type OverviewWidgetId,
  stepChange,
  visibleWidgets,
  widgetMinimum,
} from "@/lib/views/overview-layout/domain/layout";

export interface WidgetBody {
  /** The page behind the widget. */
  link: { href: string; label: string } | null;
  body: ReactNode;
}

/** The person's widgets, in their places. A widget just shown is a skeleton until the server has read it. */
export function OverviewGrid({
  bodies,
}: {
  /** Null for a widget that the server did not read, because it was hidden. */
  bodies: Readonly<Record<OverviewWidgetId, WidgetBody | null>>;
}) {
  const { layout, editable, change } = useOverviewLayout();
  const cards = useMemo(
    () => visibleWidgets(layout).map((widget) => ({ ...widget, min: widgetMinimum(widget.id) })),
    [layout],
  );
  if (cards.length === 0) return <AllHidden />;

  function step(widget: OverviewWidgetId, name: StepName) {
    const next = stepChange(layout, widget, name);
    if (!next) return;
    const place = next.places.find(({ id }) => id === widget);
    change(
      next,
      place
        ? `${WIDGET_TITLES[widget]}: row ${place.y + 1}, column ${place.x + 1}, ${place.w} wide, ${place.h} high`
        : undefined,
    );
    // The cards' order in the page follows their places, which can take the focus away.
    requestAnimationFrame(() => document.getElementById(menuId(widget))?.focus());
  }

  function hide(widget: OverviewWidgetId) {
    change({ kind: "remove", widget }, `${WIDGET_TITLES[widget]} hidden`);
    toast({
      title: `${WIDGET_TITLES[widget]} is hidden`,
      action: {
        label: "Undo",
        onClick: () => change({ kind: "add", widget }, `${WIDGET_TITLES[widget]} shown`),
      },
    });
    requestAnimationFrame(() => document.getElementById(CUSTOMIZE_ID)?.focus());
  }

  return (
    <CardGrid
      cards={cards}
      onArrange={
        editable
          ? (items) =>
              change({
                kind: "arrange",
                places: items.map(({ id, x, y, w, h }) => ({
                  id: id as OverviewWidgetId,
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
        const widget = bodies[card.id];
        return (
          <WidgetCard
            id={card.id}
            title={WIDGET_TITLES[card.id]}
            link={widget?.link ?? null}
            edit={
              editable
                ? {
                    can: (name) => stepChange(layout, card.id, name) !== null,
                    step: (name) => step(card.id, name),
                    hide: () => hide(card.id),
                  }
                : null
            }
          >
            {widget?.body ?? <Waiting title={WIDGET_TITLES[card.id]} />}
          </WidgetCard>
        );
      }}
    </CardGrid>
  );
}

function AllHidden() {
  return (
    <p
      className="flex flex-wrap items-center gap-3 text-sm text-fg-muted"
      data-overview-hidden="all"
    >
      Every widget is hidden.
      <CustomizeButton id={`${CUSTOMIZE_ID}-empty`} />
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
