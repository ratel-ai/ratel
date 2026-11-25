# `lib/console/grid`

`layout.ts`: the arithmetic of a grid of cards that a person arranges. 12 columns, 40 px rows,
vertical compaction (`react-grid-layout/core`): `movedTo` (a drag), `resizedTo`, `stepped` (one
keyboard step), `compacted`, `inReadingOrder`. Pure, and it knows no page. The component is
`components/console/grid`. The Overview's layout (`lib/views/overview-layout`) is built on it.
