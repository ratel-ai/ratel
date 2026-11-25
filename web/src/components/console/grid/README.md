# `components/console/grid`

A grid of cards that a person arranges, on `react-grid-layout` (MIT). It knows no page: cards have
an id, a place and a minimum size, and the arithmetic is `lib/console/grid/layout.ts`.

| File | Holds |
|---|---|
| `CardGrid.tsx`, `card-grid.css` | 12 columns, 40 px rows. Without `onArrange` it is only drawn, by CSS. With it, the cards can be arranged, and no pixel moves between the two |
| `ArrangeGrid.tsx` | the drag and resize behavior, in its own chunk that loads with the first `onArrange`: a mouse drags the whole card (`data-grid-surface`), a finger its handle (`data-grid-handle`), the corner resizes, and one `onArrange` follows when a drag or a resize ends |
| `GridCells.tsx` | the same places as CSS: the server's paint, a skeleton, and the one column below `lg` |
