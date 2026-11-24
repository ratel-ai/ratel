"use client";

import { type ReactNode, useMemo, useSyncExternalStore } from "react";
import { GridLayout, type Layout, useContainerWidth } from "react-grid-layout";
import { GridCells } from "@/components/console/grid/GridCells";
import {
  compacted,
  GRID_COLUMNS,
  GRID_GAP_PX,
  GRID_ROW_PX,
  type GridItem,
  type GridMinimum,
  inReadingOrder,
  MAX_GRID_HEIGHT,
  samePlace,
} from "@/lib/console/grid/layout";

const GRID = {
  cols: GRID_COLUMNS,
  rowHeight: GRID_ROW_PX,
  margin: [GRID_GAP_PX, GRID_GAP_PX],
  containerPadding: [0, 0],
} as const;
/** A card is dragged by its header. What a person can press in there still takes the press. */
const DRAG = { handle: "[data-grid-handle]", cancel: "button, a", threshold: 4 } as const;
const RESIZE = { handles: ["se"] } as const;
/** Tailwind's `lg`. Below it the cards are one column, in reading order, and stay where they are. */
const WIDE = "(min-width: 1024px)";

export interface GridCard extends GridItem {
  min: GridMinimum;
}

/**
 * Cards on 12 columns. On a wide screen a person drags them by the header and resizes them by the
 * corner; `onArrange` says where they are when the drag or the resize ends, and only when a card
 * changed its place. The server draws the same places, so the first paint is the layout.
 */
export function CardGrid<C extends GridCard>({
  cards,
  onArrange,
  children,
}: {
  cards: readonly C[];
  /** Absent: the grid is only drawn. */
  onArrange?: (items: GridItem[]) => void;
  children: (card: C) => ReactNode;
}) {
  const wide = useSyncExternalStore(watchWide, readWide, () => false);
  const { width, containerRef, mounted } = useContainerWidth();
  const ordered = useMemo(() => inReadingOrder(cards), [cards]);
  const layout = useMemo<Layout>(
    () =>
      ordered.map(({ id, x, y, w, h, min }) => ({
        i: id,
        x,
        y,
        w,
        h,
        minW: min.w,
        minH: min.h,
        maxH: MAX_GRID_HEIGHT,
      })),
    [ordered],
  );

  function onStop(next: Layout) {
    const places = new Map(next.map(({ i, x, y, w, h }) => [i, { x, y, w, h }]));
    const arranged = compacted(
      cards.map(({ id, x, y, w, h }) => ({ id, x, y, w, h, ...places.get(id) })),
    );
    if (arranged.some((item, index) => !samePlace(item, cards[index]))) onArrange?.(arranged);
  }

  return (
    <div ref={containerRef}>
      {onArrange && wide && mounted ? (
        <GridLayout
          width={width}
          layout={layout}
          gridConfig={GRID}
          dragConfig={DRAG}
          resizeConfig={RESIZE}
          onDragStop={onStop}
          onResizeStop={onStop}
        >
          {ordered.map((card) => (
            <div key={card.id} data-grid-card={card.id}>
              {children(card)}
            </div>
          ))}
        </GridLayout>
      ) : (
        <GridCells cards={ordered}>{children}</GridCells>
      )}
    </div>
  );
}

function watchWide(onChange: () => void) {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function readWide(): boolean {
  return window.matchMedia(WIDE).matches;
}
