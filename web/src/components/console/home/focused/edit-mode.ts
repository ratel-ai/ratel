import type { OverviewItemId, OverviewLayout } from "@/lib/views/overview-layout/domain/layout";

/** The decisions of edit mode. Pure. */

export const HISTORY_ID = "overview-history";

/** The last added widget that is still on the page: a removal or a failed save takes it away. */
export function widgetToReveal(
  added: readonly OverviewItemId[],
  layout: OverviewLayout,
): OverviewItemId | null {
  const visible = new Set(layout.filter(({ removed }) => !removed).map(({ id }) => id));
  return added.findLast((id) => visible.has(id)) ?? null;
}

interface Span {
  top: number;
  bottom: number;
}

/** How far to scroll so that the box is in the view: 0 when it is whole there. A box taller than the view shows its top. */
export function scrollToReveal(box: Span, view: Span): number {
  if (box.top < view.top) return box.top - view.top;
  if (box.bottom > view.bottom) return Math.min(box.bottom - view.bottom, box.top - view.top);
  return 0;
}
