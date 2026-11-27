import type { WidgetInput } from "@/lib/views/dashboards/types";
import { canonicalJson } from "@/lib/views/dashboards/widget";

/**
 * The widget a dashboard shows expanded in place, in its address: a link opens it, a reload keeps
 * it, and Back closes it. The page's range and filter stay as they are. Safe for the browser.
 */

export const EXPANDED_PARAM = "widget";
/** The value for a widget that is not saved yet: `New widget`. */
export const NEW_WIDGET_ID = "new";

/** The id of the expanded widget, `NEW_WIDGET_ID`, or null when none is. */
export function expandedOf(search: string): string | null {
  const value = new URLSearchParams(search).get(EXPANDED_PARAM)?.trim();
  return value ? value : null;
}

/** The address with the widget expanded, or with none when `id` is null. Every other part stays. */
export function withExpanded(search: string, id: string | null): string {
  const params = new URLSearchParams(search);
  if (id) params.set(EXPANDED_PARAM, id);
  else params.delete(EXPANDED_PARAM);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/**
 * How Close leaves the expanded widget: Back, when the address is still the one this page pushed
 * to expand it (Back then shows the grid as it was); else a replace of the address, so a range or
 * a filter changed while it was open stays, and a widget opened from a link never leaves the page.
 */
export function collapseStep(current: string, pushed: string | null): "back" | "replace" {
  return pushed !== null && current === pushed ? "back" : "replace";
}

/** Whether an edit would be lost: the widget differs from the one it started from. */
export function hasUnsavedChanges(start: WidgetInput, current: WidgetInput): boolean {
  return canonicalJson(start) !== canonicalJson(current);
}

/** Pixels a pointer may move between down and up for the gesture to be a click, not a drag. */
export const CLICK_SLOP_PX = 5;

/**
 * Whether a pointer that went down at `from` and up at `to`, on `target`, expands a card: a click
 * on its body, not a drag, and not a click on a control inside it (a link, a button, a menu, a
 * field), which keeps its own action.
 */
export function expandsCard(
  from: { x: number; y: number },
  to: { x: number; y: number },
  target: { closest: (selector: string) => unknown },
): boolean {
  if (Math.hypot(to.x - from.x, to.y - from.y) > CLICK_SLOP_PX) return false;
  return !target.closest(CARD_CONTROLS);
}

const CARD_CONTROLS =
  'a, button, input, select, textarea, label, [role="menu"], [role="menuitem"], [role="option"], [data-card-control]';
