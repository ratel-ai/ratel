"use client";

import {
  lazy,
  type ReactNode,
  Suspense,
  type UIEvent,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { GridCells } from "@/components/console/grid/GridCells";
import {
  compacted,
  type GridItem,
  type GridMinimum,
  type GridPlace,
  inReadingOrder,
  samePlace,
} from "@/lib/console/grid/layout";

/** The drag and resize behavior, loaded when a person first arranges. */
const ArrangeGrid = lazy(() => import("@/components/console/grid/ArrangeGrid"));

/** Tailwind's `lg`. Below it the cards are one column, in reading order, and stay where they are. */
const WIDE = "(min-width: 1024px)";

export interface GridCard extends GridItem {
  min: GridMinimum;
}

/**
 * Cards on 12 columns. With `onArrange`, on a wide screen, a person drags them and resizes them by
 * the corner; `onArrange` says where they are when the drag or the resize ends, and only when a
 * card changed its place. Without it, the server's CSS draws the same places, to the pixel, and a
 * change between the two moves nothing: a body (`data-grid-body`) keeps its scroll.
 */
export function CardGrid<C extends GridCard>({
  cards,
  onArrange,
  children,
}: {
  cards: readonly C[];
  /** Absent: the grid is only drawn. */
  onArrange?: (items: GridItem[], taken?: string) => void;
  children: (card: C) => ReactNode;
}) {
  const wide = useMedia(WIDE);
  const container = useRef<HTMLDivElement>(null);
  const scroll = useBodyScroll(container);
  const ordered = useMemo(() => inReadingOrder(cards), [cards]);

  function onPlaces(places: ReadonlyMap<string, GridPlace>, taken?: string) {
    const arranged = compacted(
      cards.map(({ id, x, y, w, h }) => ({ id, x, y, w, h, ...places.get(id) })),
    );
    if (arranged.some((item, index) => !samePlace(item, cards[index])))
      onArrange?.(arranged, taken);
  }

  const drawn = (
    <>
      <GridCells cards={ordered}>{children}</GridCells>
      <OnMount run={scroll.restore} />
    </>
  );
  return (
    <div ref={container} onScrollCapture={scroll.remember}>
      {onArrange && wide ? (
        <Suspense fallback={drawn}>
          <ArrangeGrid cards={ordered} container={container} onPlaces={onPlaces}>
            {children as (card: GridCard) => ReactNode}
          </ArrangeGrid>
          <OnMount run={scroll.restore} />
        </Suspense>
      ) : (
        drawn
      )}
    </div>
  );
}

export function useMedia(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Where each body is scrolled to, across the two grids. */
function useBodyScroll(container: { readonly current: HTMLElement | null }) {
  const seen = useRef(new Map<string, { top: number; left: number }>());
  const remember = useCallback((event: UIEvent) => {
    const target = event.target as HTMLElement;
    const card = target.closest<HTMLElement>("[data-grid-card]");
    if (!card) return;
    const index = scrollers(card).indexOf(target);
    if (index < 0) return;
    seen.current.set(`${card.dataset.gridCard}:${index}`, {
      top: target.scrollTop,
      left: target.scrollLeft,
    });
  }, []);
  const restore = useCallback(() => {
    for (const card of container.current?.querySelectorAll<HTMLElement>("[data-grid-card]") ?? []) {
      const elements = scrollers(card);
      for (const [index, element] of elements.entries()) {
        const at = seen.current.get(`${card.dataset.gridCard}:${index}`);
        if (at) element.scrollTo({ ...at, behavior: "instant" });
      }
    }
  }, [container]);
  return { remember, restore };
}

function scrollers(card: HTMLElement): HTMLElement[] {
  return [...card.querySelectorAll<HTMLElement>("[data-grid-body], [data-grid-body] *")];
}

function OnMount({ run }: { run: () => void }) {
  useLayoutEffect(run, [run]);
  return null;
}
