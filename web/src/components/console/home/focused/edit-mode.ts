import type { OverviewLayout, OverviewWidgetId } from "@/lib/views/overview-layout/domain/layout";

/** The decisions of edit mode. Pure. */

export const HISTORY_ID = "overview-history";

/** What is on the page when a key goes down, before anything reacts to it. */
export interface KeyMoment {
  key: string;
  /** Held down, or part of a text composition. */
  continued: boolean;
  /** A dialog, menu, Panel, command palette or list is open: the key is its own. */
  layerOpen: boolean;
  /** A drag or a resize is in progress. */
  arranging: boolean;
  /** The focus is in a text field or in a toast, which answer the key themselves. */
  fieldFocused: boolean;
}

export function keyLeavesEditMode(at: KeyMoment): boolean {
  return at.key === "Escape" && !at.continued && !at.layerOpen && !at.arranging && !at.fieldFocused;
}

/** The last added widget that is still on the page: a removal or a failed save takes it away. */
export function widgetToReveal(
  added: readonly OverviewWidgetId[],
  layout: OverviewLayout,
): OverviewWidgetId | null {
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
