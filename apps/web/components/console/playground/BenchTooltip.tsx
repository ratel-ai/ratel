import { Tooltip as DsTooltip } from "@ratel/design-system/tooltip";
import type { ReactElement, ReactNode } from "react";

/** The design system's Tooltip with this screen's surface and arrow. */
export function Tooltip({
  content,
  side = "top",
  children,
}: {
  content: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactElement;
}) {
  return (
    <DsTooltip
      arrow
      content={content}
      side={side}
      className="block max-w-[19rem] rounded-lg border-forest-300 bg-base-deep/95 px-2.5 py-1.5 text-[11px] leading-5 text-cream-dim shadow-xl backdrop-blur-sm"
    >
      {children}
    </DsTooltip>
  );
}
