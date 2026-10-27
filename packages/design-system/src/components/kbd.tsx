import type { ReactNode } from "react";
import { cn } from "../cn";

/** A keyboard shortcut hint ("⌘K", "["). */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-raised px-1 font-sans text-xs text-fg-subtle",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
