"use client";

import { cn } from "@ratel/design-system/cn";
import { type ReactNode, useState } from "react";

/**
 * A group that folds: its heading is a button, and its content grows from no
 * height to its own (and slides and fades in) as it opens, and back as it
 * closes. Folded by default. The heading's own parts read the state from
 * `data-open` on the `group/fold` element (a chevron turns with
 * `group-data-[open=true]/fold:rotate-90`).
 */
export function FoldGroup({
  heading,
  headingClassName,
  children,
  ...rest
}: { heading: ReactNode; headingClassName?: string; children: ReactNode } & Record<
  `data-${string}`,
  string
>) {
  const [open, setOpen] = useState(false);
  return (
    <div className="group/fold" data-open={open ? "true" : "false"} {...rest}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn("w-full text-left", headingClassName)}
      >
        {heading}
      </button>
      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
        inert={!open}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            className={cn(
              "transition-transform duration-300 ease-out motion-reduce:transition-none",
              open ? "translate-y-0" : "-translate-y-2",
            )}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
