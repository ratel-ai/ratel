# `components/console/grid`

A grid of cards that a person arranges, on `react-grid-layout` (MIT). It knows no page: cards have
an id, a place and a minimum size, and the arithmetic is `lib/console/grid/layout.ts`.

| File | Holds |
|---|---|
| `CardGrid.tsx`, `card-grid.css` | 12 columns, 40 px rows: drag by the header (`data-grid-handle`), resize by the corner, one `onArrange` when a drag or a resize ends. Without `onArrange` it is only drawn |
| `GridCells.tsx` | the same places as CSS: the server's first paint, a skeleton, and the one column below `lg` |
