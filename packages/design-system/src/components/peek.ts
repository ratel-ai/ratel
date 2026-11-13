/**
 * The open Panel lives in the URL (`?peek=<id>`), so refresh, back and a shared
 * link all land on the same row with its Panel open (DESIGN.md, Everything is a
 * URL). Pure helpers, kept apart from the hook so they test without a router.
 */

export const PEEK_PARAM = "peek";

/** The query string (with its `?`, or empty) after opening `id`, or closing when `id` is null. */
export function withPeek(search: string, id: string | null, param: string = PEEK_PARAM): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (id === null || id === "") params.delete(param);
  else params.set(param, id);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** The row to show after `j` (next) or `k` (previous), clamped to the list; -1 for an empty list. */
export function stepIndex(current: number, direction: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return direction === 1 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, current + direction));
}

/** The least time between two `j`/`k` steps: each step can load a record. */
export const STEP_INTERVAL_MS = 150;

/**
 * Whether a `j` or `k` press may step now: never on the keyboard's own repeat
 * (a held key is one step, not thirty loads), and not sooner than the interval
 * after the last step. `lastStepAt` is that step's event time, or null.
 */
export function canStep(
  event: { repeat: boolean; timeStamp: number },
  lastStepAt: number | null,
  interval: number = STEP_INTERVAL_MS,
): boolean {
  if (event.repeat) return false;
  return lastStepAt === null || event.timeStamp - lastStepAt >= interval;
}

/** Roles whose own keyboard handling (typeahead, arrows) single letters must not steal. */
const KEYBOARD_ROLES = new Set([
  "combobox",
  "listbox",
  "option",
  "menu",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "textbox",
  "searchbox",
  "slider",
  "spinbutton",
]);

/** Single-letter shortcuts must never fire while someone is typing or steering a widget. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object" || !("tagName" in target)) return false;
  const element = target as {
    tagName: string;
    isContentEditable?: boolean;
    getAttribute?: (name: string) => string | null;
  };
  const tag = element.tagName.toLowerCase();
  if (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    element.isContentEditable === true
  )
    return true;
  const role = element.getAttribute?.("role");
  return role ? KEYBOARD_ROLES.has(role) : false;
}

/**
 * React bubbles events through portals, so a menu opened from a row reports
 * its clicks and keys to the row. Handlers check this first.
 */
export function eventFromInside(event: {
  currentTarget: EventTarget;
  target: EventTarget;
}): boolean {
  const container = event.currentTarget as { contains?: (node: unknown) => boolean };
  return container.contains ? container.contains(event.target) : true;
}
