"use client";

import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import { cn } from "../cn";
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
  /** Merged over the popup's surface. */
  className?: string;
  /** Draws the arrow pointing at the trigger. */
  arrow?: boolean;
};

export function Tooltip({
  content,
  children,
  shortcut,
  side = "top",
  disabled,
  className,
  arrow = false,
}: TooltipProps) {
  if (disabled) return children;
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6} className="z-popover">
          <BaseTooltip.Popup
            className={cn(
              "flex items-center gap-2 rounded-md border border-line bg-overlay px-2 py-1 text-xs text-fg shadow-overlay",
              "origin-(--transform-origin) transition-[scale,opacity] duration-120 ease-enter",
              "data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:opacity-0",
              "data-instant:transition-none motion-reduce:transition-none",
              className,
            )}
          >
            {arrow ? (
              <BaseTooltip.Arrow className="text-line">
                {/* biome-ignore lint/a11y/noSvgWithoutTitle: decorative; the popup carries the text. */}
                <svg width="10" height="5" viewBox="0 0 10 5" aria-hidden>
                  <path d="M0 5 L5 0 L10 5 Z" fill="var(--color-base-deep)" />
                  <path d="M0 5 L5 0 L10 5" fill="none" stroke="currentColor" strokeWidth="1" />
                </svg>
              </BaseTooltip.Arrow>
            ) : null}
            <span>{content}</span>
            {shortcut ? <Kbd>{shortcut}</Kbd> : null}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
