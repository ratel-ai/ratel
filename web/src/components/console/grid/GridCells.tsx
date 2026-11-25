import type { CSSProperties, ReactNode } from "react";
import type { GridItem } from "@/lib/console/grid/layout";

/** The same places without the script: what the server sends, and the one column of a narrow screen. */
export function GridCells<C extends GridItem>({
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
          className="min-w-0 lg:[grid-column:var(--cell-column)] lg:[grid-row:var(--cell-row)]"
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
  } as CSSProperties;
}
