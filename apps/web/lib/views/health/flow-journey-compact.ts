import { type AcrossInput, layoutAcross } from "@/lib/views/health/flow-journey-across";
import {
  JOURNEY_GRID,
  type JourneyColumn,
  type JourneyFocus,
  type JourneyLayout,
  type JourneyLink,
  type JourneyNode,
  placeJourneyRibbons,
} from "@/lib/views/health/flow-journey-layout";

/**
 * The journey packed down to what a focus keeps, for the prerequisites view:
 *
 * - only the chips the focus lights, each keeping its key (so a chip moving
 *   between this and the full map is the same chip, gliding);
 * - only the columns that still hold a chip, packed left to right on the full
 *   map's gaps (an empty start column, "Later" or "Then" column is dropped);
 * - in each column, the chips in the full map's order, stacked top down with
 *   no holes;
 * - the lit links only, each as thick as the turns it carries here, placed
 *   the way the full map places ribbons.
 *
 * Columns keep their role and call, so their titles stay "1st call" and so
 * on. Nothing folds: the result is complete and never unfolds on scroll.
 *
 * Pairs the journey cannot draw (`across`) follow as rows under it, in its
 * first two columns, each a direct link between two chips
 * (`flow-journey-across`).
 */
export function compactJourney(
  layout: JourneyLayout,
  focus: JourneyFocus,
  across?: AcrossInput,
): JourneyLayout {
  const lit = (key: string) => focus.nodes.get(key) ?? 0;
  const kept = layout.nodes.filter((node) => lit(node.key) > 0);
  const used = layout.columns.filter((column) => kept.some((node) => node.column === column.index));

  let left: number = JOURNEY_GRID.padX;
  const columns: JourneyColumn[] = used.map((column, index) => {
    const placed = {
      ...column,
      index,
      x: left,
      turns: kept
        .filter((node) => node.column === column.index && node.kind !== "ended")
        .reduce((sum, node) => sum + lit(node.key), 0),
    };
    left += column.width + JOURNEY_GRID.gap;
    return placed;
  });

  const pitch = JOURNEY_GRID.chipH + JOURNEY_GRID.chipGap;
  const nodes: JourneyNode[] = used.flatMap((column, index) =>
    kept
      .filter((node) => node.column === column.index)
      .sort((a, b) => a.y - b.y || a.order - b.order)
      .map((node, order) => ({
        ...node,
        column: index,
        order,
        x: columns[index].x,
        y: JOURNEY_GRID.padTop + order * pitch,
      })),
  );

  const byKey = new Map(layout.ribbons.map((ribbon) => [ribbon.key, ribbon]));
  const links: JourneyLink[] = [...focus.ribbons].flatMap(([key, turns]) => {
    const ribbon = byKey.get(key);
    return ribbon && turns > 0
      ? [{ key, from: ribbon.from, to: ribbon.to, family: ribbon.family, turns }]
      : [];
  });

  const journeyBottom = Math.max(JOURNEY_GRID.padTop, ...nodes.map((node) => node.y + node.h));
  const band = across
    ? layoutAcross(across, columns, journeyBottom)
    : { columns: [], nodes: [], links: [], dividers: [] };
  const allColumns = [...columns, ...band.columns];
  const allNodes = [...nodes, ...band.nodes];
  const right = Math.max(
    0,
    ...allColumns.map((c) => c.x + c.width),
    ...allNodes.map((n) => n.x + n.w),
  );
  const bottom = Math.max(JOURNEY_GRID.padTop, ...allNodes.map((node) => node.y + node.h));
  return {
    ...layout,
    depth: layout.calls,
    expanded: {},
    width: right > 0 ? right + JOURNEY_GRID.padX : 0,
    height: bottom + JOURNEY_GRID.padBottom,
    hiddenLinks: 0,
    columns: allColumns,
    nodes: allNodes,
    ribbons: placeJourneyRibbons(links, nodes, layout.scale),
    links: band.links,
    dividers: band.dividers,
  };
}
