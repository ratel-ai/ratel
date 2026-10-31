"use client";

import { type PointerEvent, useRef } from "react";
import type { Point } from "@/lib/views/intents/map/map-geometry";

/** A press that moves this far (screen pixels) is a drag, not a click. */
const DRAG_START = 4;

type Drag = {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  origin: Point;
  moved: boolean;
};

/**
 * Dragging one mark of a drawing: the pointer is captured on press, a move
 * past `DRAG_START` becomes a drag that reports where the mark should be (map
 * units, at the current zoom `scale()`), and the click that ends a drag is
 * swallowed so it does not also open the mark.
 */
export function useNodeDrag({
  positionOf,
  scale,
  onDrag,
}: {
  positionOf: (id: string) => Point | null;
  scale: () => number;
  onDrag: (id: string, at: Point) => void;
}) {
  const dragRef = useRef<Drag | null>(null);
  /** A press that became a drag is not also a click. */
  const draggedRef = useRef(false);
  return {
    /** Whether a mark is being dragged now. */
    dragging: () => dragRef.current !== null,
    onPointerDown(event: PointerEvent<SVGGElement>, id: string) {
      const origin = positionOf(id);
      draggedRef.current = false;
      if (event.button !== 0 || !origin) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        id,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        origin: { x: origin.x, y: origin.y },
        moved: false,
      };
    },
    onPointerMove(event: PointerEvent<SVGGElement>) {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_START) return;
      drag.moved = true;
      const k = scale();
      onDrag(drag.id, { x: drag.origin.x + dx / k, y: drag.origin.y + dy / k });
    },
    onPointerUp(event: PointerEvent<SVGGElement>) {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
      draggedRef.current = drag.moved;
      dragRef.current = null;
    },
    /** True once for the click that ends a drag. */
    endedDrag() {
      const ended = draggedRef.current;
      draggedRef.current = false;
      return ended;
    },
  };
}
