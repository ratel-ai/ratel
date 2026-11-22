import { cn } from "@ratel/design-system/cn";
import Link from "next/link";
import type { ReactNode } from "react";

export type LinkSwitchOption = { href: string; label: ReactNode; active: boolean };

/**
 * A segmented switch whose options are links, so the choice lives in the URL
 * and survives a reload (DESIGN.md, Everything is a URL). Same look as the
 * ds SegmentedControl.
 */
export function LinkSwitch({
  options,
  label,
  className,
}: {
  options: readonly LinkSwitchOption[];
  label: string;
  className?: string;
}) {
  return (
    <nav
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border border-line bg-app p-0.5",
        className,
      )}
    >
      {options.map((option) => (
        <Link
          key={option.href}
          href={option.href}
          scroll={false}
          aria-current={option.active ? "true" : undefined}
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded-[4px] px-2 text-ui font-medium whitespace-nowrap outline-none transition-colors duration-120 focus-visible:ring-2 focus-visible:ring-focus",
            option.active ? "bg-selected text-fg" : "text-fg-muted hover:text-fg",
          )}
        >
          {option.label}
        </Link>
      ))}
    </nav>
  );
}
