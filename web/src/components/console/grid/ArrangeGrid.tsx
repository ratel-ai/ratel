"use client";

import { type CSSProperties, type ReactNode, useLayoutEffect, useMemo, useState } from "react";
import { GridLayout, type Layout } from "react-grid-layout";
import { type GridCard, useMedia } from "@/components/console/grid/CardGrid";
import {
  GRID_COLUMNS,
  GRID_GAP_PX,
  GRID_ROW_PX,
  type GridPlace,
  MAX_GRID_HEIGHT,
} from "@/lib/console/grid/layout";

const GRID = {
  cols: GRID_COLUMNS,
  rowHeight: GRID_ROW_PX,
  margin: [GRID_GAP_PX, GRID_GAP_PX],
  containerPadding: [0, 0],
} as const;
const RESIZE = { handles: ["se"] } as const;
/** What a person can press in a card still takes the press. */
const DRAG = { cancel: "button, a", threshold: 4 } as const;
/** A finger drags by the handle: anywhere else it scrolls the page. */
const HANDLE = "[data-grid-handle]";
const SURFACE = "[data-grid-handle], [data-grid-surface]";

/** The grid while a person arranges it. Loaded by `CardGrid`. */
export default function ArrangeGrid({
  cards,
  container,
  onPlaces,
  children,
}: {
  cards: readonly GridCard[];
  container: { readonly current: HTMLElement | null };
  onPlaces: (places: ReadonlyMap<string, GridPlace>) => void;
  children: (card: GridCard) => ReactNode;
}) {
  const width = useWidth(container);
  const mouse = useMedia("(hover: hover)");
  const layout = useMemo<Layout>(
    () =>
      cards.map(({ id, x, y, w, h, min }) => ({
        i: id,
        x,
        y,
        w,
        h,
        minW: min.w,
        minH: min.h,
        maxH: MAX_GRID_HEIGHT,
      })),
    [cards],
  );
  const drag = useMemo(() => ({ ...DRAG, handle: mouse ? SURFACE : HANDLE }), [mouse]);

  function onStop(next: Layout) {
    onPlaces(new Map(next.map(({ i, x, y, w, h }) => [i, { x, y, w, h }])));
  }

  return (
    <GridLayout
      width={width}
      layout={layout}
      gridConfig={GRID}
      dragConfig={drag}
      resizeConfig={RESIZE}
      onDragStop={onStop}
      onResizeStop={onStop}
    >
      {cards.map((card) => (
        <div key={card.id} data-grid-card={card.id}>
          <div data-grid-exact="" style={exactly(card, width)}>
            {children(card)}
          </div>
        </div>
      ))}
    </GridLayout>
  );
}

function useWidth(container: { readonly current: HTMLElement | null }): number {
  const [width, setWidth] = useState(() => widthOf(container.current));
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(widthOf(element)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [container]);
  return width;
}

function widthOf(element: HTMLElement | null): number {
  return element?.getBoundingClientRect().width ?? 0;
}

/** The library rounds a card to whole pixels; the CSS grid does not, and its place is the one to keep. */
function exactly({ x, w }: GridPlace, width: number): CSSProperties {
  const step = (width - GRID_GAP_PX * (GRID_COLUMNS - 1)) / GRID_COLUMNS + GRID_GAP_PX;
  return {
    "--exact-left": `${step * x - Math.round(step * x)}px`,
    "--exact-width": `${step * w - GRID_GAP_PX}px`,
  } as CSSProperties;
}
