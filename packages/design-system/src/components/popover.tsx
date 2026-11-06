"use client";

import { Popover as BasePopover } from "@base-ui/react/popover";
import type { ReactNode } from "react";
import { cn } from "../cn";

export const Popover = BasePopover.Root;
export const PopoverTrigger = BasePopover.Trigger;
export const PopoverClose = BasePopover.Close;

/** Floating material: 12 px radius, overlay surface, one border, layered shadow. */
export const FLOATING_SURFACE =
  "rounded-xl border border-line bg-overlay text-fg shadow-overlay outline-none focus-visible:outline-none origin-(--transform-origin) transition-[scale,opacity] duration-160 ease-enter data-starting-style:scale-[0.97] data-starting-style:opacity-0 data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-ending-style:duration-120 data-ending-style:ease-exit motion-reduce:transition-none";

export function PopoverContent({
  children,
  className,
  side = "bottom",
  align = "start",
  title,
}: {
  children: ReactNode;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  /** Optional heading; also names the popup for assistive tech. */
  title?: string;
}) {
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner side={side} align={align} sideOffset={6} className="z-popover">
        <BasePopover.Popup className={cn(FLOATING_SURFACE, "min-w-56 p-3", className)}>
          {title ? (
            <BasePopover.Title className="mb-2 text-sm font-semibold text-fg">
              {title}
            </BasePopover.Title>
          ) : null}
          {children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}
