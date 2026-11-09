import type { TourPlacement } from "@/lib/console/onboarding/tour-steps";

/**
 * Where the spotlight hole and the explanation card go.
 *
 * Pure arithmetic, kept out of the component so the awkward cases (a target
 * near the bottom of a short viewport, a card wider than the space beside the
 * rail) can be tested as numbers instead of chased around a browser.
 */

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** Breathing room between the target and the spotlight edge. */
export const SPOTLIGHT_PADDING = 8;
/** Gap between the spotlight edge and the card. */
const CARD_GAP = 14;
/** Keep the card clear of the viewport edges. */
const VIEWPORT_MARGIN = 16;

/** Grow a target rect into the lit region, clamped to the viewport. */
export function spotlightRect(target: Rect, viewport: Viewport): Rect {
  const top = Math.max(0, target.top - SPOTLIGHT_PADDING);
  const left = Math.max(0, target.left - SPOTLIGHT_PADDING);
  return {
    top,
    left,
    width: Math.min(target.width + SPOTLIGHT_PADDING * 2, Math.max(0, viewport.width - left)),
    height: Math.min(target.height + SPOTLIGHT_PADDING * 2, Math.max(0, viewport.height - top)),
  };
}

export interface CardPosition {
  top: number;
  left: number;
  /** The side actually used, after flipping. Drives the card's arrow, if any. */
  placement: TourPlacement;
}

/**
 * Place the card beside the spotlight on the requested side, flipping to the
 * opposite side when it does not fit, then clamping so it never leaves the
 * viewport.
 *
 * Clamping runs even after the flip, because on a narrow screen NEITHER side
 * fits, and a card half off-screen is a dead end for someone who cannot scroll
 * a fixed overlay. Overlapping the spotlight is the lesser failure: the text is
 * still readable, and the highlighted element is still visibly the subject.
 */
export function cardPosition(
  spotlight: Rect,
  card: { width: number; height: number },
  viewport: Viewport,
  placement: TourPlacement,
): CardPosition {
  const fits = {
    right:
      spotlight.left + spotlight.width + CARD_GAP + card.width <= viewport.width - VIEWPORT_MARGIN,
    left: spotlight.left - CARD_GAP - card.width >= VIEWPORT_MARGIN,
    bottom:
      spotlight.top + spotlight.height + CARD_GAP + card.height <=
      viewport.height - VIEWPORT_MARGIN,
    top: spotlight.top - CARD_GAP - card.height >= VIEWPORT_MARGIN,
  };
  const opposite: Record<TourPlacement, TourPlacement> = {
    right: "left",
    left: "right",
    top: "bottom",
    bottom: "top",
  };
  const resolved = fits[placement]
    ? placement
    : fits[opposite[placement]]
      ? opposite[placement]
      : placement;

  const raw =
    resolved === "right"
      ? {
          top: spotlight.top,
          left: spotlight.left + spotlight.width + CARD_GAP,
        }
      : resolved === "left"
        ? {
            top: spotlight.top,
            left: spotlight.left - CARD_GAP - card.width,
          }
        : resolved === "bottom"
          ? {
              top: spotlight.top + spotlight.height + CARD_GAP,
              left: spotlight.left,
            }
          : {
              top: spotlight.top - CARD_GAP - card.height,
              left: spotlight.left,
            };

  return {
    placement: resolved,
    top: clamp(raw.top, viewport.height, card.height),
    left: clamp(raw.left, viewport.width, card.width),
  };
}

function clamp(value: number, available: number, size: number): number {
  const max = Math.max(VIEWPORT_MARGIN, available - size - VIEWPORT_MARGIN);
  return Math.min(Math.max(value, VIEWPORT_MARGIN), max);
}
