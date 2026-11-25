import type { GridPlace } from "@/lib/console/grid/layout";

/** The decisions of edit mode, on any page with a grid of cards. Pure. */

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

/** A toast has the role of a dialog, and it blocks nothing. */
export const TOASTS = "[role='region'][aria-label='Notifications']";

/** Whether an element with the role of a layer answers Escape. One in a card does not: a chart's readout is a list, and edit mode makes it inert. */
export function takesEscape(layer: { closest: (selector: string) => unknown }): boolean {
  return !layer.closest(TOASTS) && !layer.closest("[data-grid-body]");
}

/** What a screen reader says after a step. */
export function placeWords(title: string, { x, y, w, h }: GridPlace): string {
  return `${title}: row ${y + 1}, column ${x + 1}, ${w} wide, ${h} high`;
}
