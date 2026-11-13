export interface PopoverPosition {
  left: number;
  top: number;
  maxHeight: number;
  placement: "above" | "below";
}

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface Size {
  width: number;
  height: number;
}

/** Position a fixed popover, flipping and shifting it within viewport padding. */
export function placePopover({
  anchor,
  popover,
  viewport,
  align,
  gap = 8,
  padding = 12,
}: {
  anchor: Rect;
  popover: Size;
  viewport: Size;
  align: "start" | "end";
  gap?: number;
  padding?: number;
}): PopoverPosition {
  const maxWidth = Math.max(0, viewport.width - padding * 2);
  const maxHeight = Math.max(0, viewport.height - padding * 2);
  const panelWidth = Math.min(popover.width, maxWidth);
  const panelHeight = Math.min(popover.height, maxHeight);
  const preferredLeft = align === "end" ? anchor.right - panelWidth : anchor.left;
  const left = clamp(
    preferredLeft,
    padding,
    Math.max(padding, viewport.width - padding - panelWidth),
  );
  const spaceBelow = viewport.height - padding - anchor.bottom - gap;
  const spaceAbove = anchor.top - gap - padding;

  if (popover.height <= spaceBelow) {
    return {
      left,
      top: anchor.bottom + gap,
      maxHeight,
      placement: "below",
    };
  }
  if (popover.height <= spaceAbove) {
    return {
      left,
      top: anchor.top - gap - panelHeight,
      maxHeight,
      placement: "above",
    };
  }

  return {
    left,
    top: padding,
    maxHeight,
    placement: spaceBelow >= spaceAbove ? "below" : "above",
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
