"use client";

import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { cn } from "@ratel/design-system/cn";
import type { ReactElement, ReactNode } from "react";

export type TooltipSide = "top" | "bottom" | "left" | "right";

/**
 * A styled tooltip, for the cases where a native `title` is not good enough.
 *
 * The browser's own tooltip is unstyled, appears after a ~1s delay the user has
 * to wait out, cannot be positioned, and truncates awkwardly on long strings.
 * That is tolerable for a supplementary hint; it is not tolerable when the
 * tooltip carries the *meaning of an icon*, which is the only way to read a
 * provenance glyph.
 *
 * The trigger keeps its own `aria-label`, so the accessible name does not
 * depend on the popup being mounted.
 */
export function Tooltip({
  content,
  side = "top",
  children,
}: {
  content: ReactNode;
  side?: TooltipSide;
  /** The element the tooltip describes. Must accept a ref and DOM props. */
  children: ReactElement;
}) {
  // `delay` lives on Provider, not Root, in @base-ui/react v1. Each tooltip
  // brings its own so a call site never has to remember to wrap the tree.
  // Getting the delay wrong silently reintroduces the sluggish native feel.
  return (
    <BaseTooltip.Provider delay={120} closeDelay={60}>
      <BaseTooltip.Root>
        <BaseTooltip.Trigger render={children} />
        <BaseTooltip.Portal>
          <BaseTooltip.Positioner side={side} sideOffset={7} className="z-50">
            <BaseTooltip.Popup
              className={cn(
                "max-w-[19rem] rounded-lg border border-forest-300 bg-base-deep/95 px-2.5 py-1.5",
                "text-[11px] leading-5 text-cream-dim shadow-xl backdrop-blur-sm",
                "origin-[var(--transform-origin)] transition-[transform,opacity] duration-150",
                "data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
                "data-[ending-style]:scale-95 data-[starting-style]:scale-95",
              )}
            >
              <BaseTooltip.Arrow className="text-forest-300">
                <ArrowGlyph />
              </BaseTooltip.Arrow>
              {content}
            </BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
    </BaseTooltip.Provider>
  );
}

function ArrowGlyph() {
  return (
    <svg width="10" height="5" viewBox="0 0 10 5" aria-hidden>
      <path d="M0 5 L5 0 L10 5 Z" fill="var(--color-base-deep)" />
      <path d="M0 5 L5 0 L10 5" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}
