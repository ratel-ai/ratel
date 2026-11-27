import { cn } from "@ratel/design-system/cn";
import type { CSSProperties, ReactNode } from "react";
import { GRID_GAP_PX, GRID_ROW_PX, type GridItem } from "@/lib/console/grid/layout";

export interface GridCell extends GridItem {
  /** On a narrow screen it keeps its height: its content fills what there is. */
  ownHeight?: boolean;
}

/** The same places without the script: what the server sends, and the one column of a narrow screen. */
export function GridCells<C extends GridCell>({
  cards,
  children,
}: {
  cards: readonly C[];
  children: (card: C) => ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:auto-rows-[40px] lg:grid-cols-12">
      {cards.map((card) => (
        <div
          key={card.id}
          data-grid-card={card.id}
          style={cellOf(card)}
          className={cn(
            // A readout may reach over the next card.
            "min-w-0 hover:z-1 focus-within:z-1 lg:[grid-column:var(--cell-column)] lg:[grid-row:var(--cell-row)]",
            card.ownHeight && "max-lg:h-(--cell-height)",
          )}
        >
          {children(card)}
        </div>
      ))}
    </div>
  );
}

function cellOf({ x, y, w, h }: GridItem): CSSProperties {
  return {
    "--cell-column": `${x + 1} / span ${w}`,
    "--cell-row": `${y + 1} / span ${h}`,
    "--cell-height": `${h * (GRID_ROW_PX + GRID_GAP_PX) - GRID_GAP_PX}px`,
  } as CSSProperties;
}
