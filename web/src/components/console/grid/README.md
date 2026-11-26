# `components/console/grid`

A grid of cards that a person arranges, on `react-grid-layout` (MIT). It knows no page: cards have
an id, a place and a minimum size, and the arithmetic is `lib/console/grid/layout.ts`.

| File | Holds |
|---|---|
| `CardGrid.tsx`, `card-grid.css` | 12 columns, 40 px rows. Without `onArrange` it is only drawn, by CSS. With it, the cards can be arranged, and no pixel moves between the two |
| `ArrangeGrid.tsx` | the drag and resize behavior, in its own chunk that loads with the first `onArrange`: a mouse drags the whole card (`data-grid-surface`), a finger its handle (`data-grid-handle`), the corner resizes, and one `onArrange` follows when a drag or a resize ends. Until then the held card (`data-grid-held`) follows the pointer, lifted, over a placeholder at its landing place |
| `GridCells.tsx` | the same places as CSS: the server's paint, a skeleton, and the one column below `lg`, where a card with `ownHeight` keeps its height |
| `CardFrame.tsx` | one card: quiet, or in edit mode with its border, its handle, its Arrange menu (the page's own items, then the steps), Remove, and the resize corner: always shown, it takes the focus and an arrow key is one step (the page announces the new place). A pointer resizes by the grid's handle over it, 44 px on touch. `titleRow` draws the title where the content does not say what it is |
| `EditBar.tsx` | `EditModeBar` over the header, with Done and Escape, and `InertHeader` under it |

The Overview (`home/focused`) and dashboards (`dashboards`) use all of it. Add what a page needs
here, not beside it.
