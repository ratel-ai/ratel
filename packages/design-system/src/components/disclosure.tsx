"use client";

import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../cn";

/**
 * Detail on demand (DESIGN.md, Principles 2 and 3): the specialist's numbers,
 * formulas and engine names live behind one quiet "Details" row, closed by
 * default, so the default view answers its question in plain words. The panel
 * stays in the DOM while closed, so the browser's find-in-page can still open
 * it.
 */
export function Disclosure({
  title = "Details",
  hint,
  defaultOpen = false,
  children,
  className,
}: {
  title?: ReactNode;
  /** One quiet line after the title: what is inside. */
  hint?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Collapsible.Root defaultOpen={defaultOpen} className={cn("flex flex-col", className)}>
      <Collapsible.Trigger className="group inline-flex h-8 items-center gap-1.5 self-start rounded-md pr-2 pl-1 text-ui font-medium text-fg-muted outline-none transition-colors duration-120 hover:text-fg focus-visible:ring-2 focus-visible:ring-focus">
        <ChevronRight
          aria-hidden
          className="size-3.5 text-fg-subtle transition-transform duration-160 ease-enter group-data-panel-open:rotate-90 motion-reduce:transition-none"
        />
        {title}
        {hint ? <span className="font-normal text-fg-subtle">{hint}</span> : null}
      </Collapsible.Trigger>
      <Collapsible.Panel
        hiddenUntilFound
        className="pt-3 transition-opacity duration-160 ease-enter data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none"
      >
        {children}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
