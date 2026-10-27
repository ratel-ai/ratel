"use client";

import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import { Kbd } from "./kbd";

/**
 * Shares one open delay across a region: the first tooltip waits, the ones
 * after it open at once while the pointer moves along a toolbar or the rail.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <BaseTooltip.Provider delay={500} closeDelay={0}>
      {children}
    </BaseTooltip.Provider>
  );
}

export type TooltipProps = {
  /** What the trigger does or the full value it truncates. Never essential information. */
  content: ReactNode;
  /** The trigger. It must accept a ref and props (a ds Button, a link, a span). */
  children: ReactElement;
  shortcut?: string;
  side?: "top" | "bottom" | "left" | "right";
  disabled?: boolean;
};

export function Tooltip({ content, children, shortcut, side = "top", disabled }: TooltipProps) {
  if (disabled) return children;
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6} className="z-popover">
          <BaseTooltip.Popup
            className={[
              "flex items-center gap-2 rounded-md border border-line bg-overlay px-2 py-1 text-xs text-fg shadow-overlay",
              "origin-(--transform-origin) transition-[scale,opacity] duration-120 ease-enter",
              "data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:opacity-0",
              "data-instant:transition-none motion-reduce:transition-none",
            ].join(" ")}
          >
            <span>{content}</span>
            {shortcut ? <Kbd>{shortcut}</Kbd> : null}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
