"use client";

import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "../cn";
import { isCurrentTab } from "./tab-model";

const TAB =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-ui font-medium whitespace-nowrap text-fg-muted outline-none transition-colors duration-120 hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus [&_svg]:size-3.5";
const TAB_ACTIVE = "bg-selected text-fg hover:bg-selected";

export type TabLink = {
  href: string;
  label: ReactNode;
  /** Count or badge after the label. */
  meta?: ReactNode;
  /** Match the pathname exactly (an index tab), instead of as a prefix. */
  exact?: boolean;
};

/**
 * Page sections where each tab is its own URL (DESIGN.md, Everything is a URL).
 * Compact, rounded, neutral: selection is a surface, not a coral underline.
 */
export function TabNav({
  tabs,
  label,
  className,
}: {
  tabs: readonly TabLink[];
  label: string;
  className?: string;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className={cn("flex items-center gap-1 overflow-x-auto", className)}>
      {tabs.map((tab) => {
        const active = isCurrentTab(tab.href, pathname, tab.exact);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(TAB, active && TAB_ACTIVE)}
          >
            {tab.label}
            {tab.meta !== undefined ? (
              <span className="text-xs text-fg-subtle tabular-nums">{tab.meta}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

/** In-page tabs over local state, for content that does not deserve its own URL (inside a Panel). */
export function Tabs({
  items,
  defaultValue,
  value,
  onValueChange,
  className,
}: {
  items: readonly { value: string; label: ReactNode; content: ReactNode }[];
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  className?: string;
}) {
  return (
    <BaseTabs.Root
      defaultValue={defaultValue ?? items[0]?.value}
      value={value}
      onValueChange={(next) => onValueChange?.(String(next))}
      className={cn("flex flex-col gap-3", className)}
    >
      <BaseTabs.List className="flex items-center gap-1">
        {items.map((item) => (
          <BaseTabs.Tab
            key={item.value}
            value={item.value}
            className={cn(TAB, "data-active:bg-selected data-active:text-fg")}
          >
            {item.label}
          </BaseTabs.Tab>
        ))}
      </BaseTabs.List>
      {items.map((item) => (
        <BaseTabs.Panel
          key={item.value}
          value={item.value}
          className="outline-none focus-visible:outline-none"
        >
          {item.content}
        </BaseTabs.Panel>
      ))}
    </BaseTabs.Root>
  );
}

/** Switch between views of the same data (Map and Flow, Daily and Total). */
export function SegmentedControl<T extends string>({
  options,
  value,
  onValueChange,
  label,
  className,
}: {
  options: readonly { value: T; label: ReactNode }[];
  value: T;
  onValueChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      onValueChange={(next) => {
        const picked = next[0];
        if (picked !== undefined) onValueChange(picked as T);
      }}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border border-line bg-app p-0.5",
        className,
      )}
    >
      {options.map((option) => (
        <Toggle
          key={option.value}
          value={option.value}
          className="inline-flex h-6 items-center rounded-[4px] px-2 text-ui font-medium text-fg-muted outline-none transition-colors duration-120 hover:text-fg focus-visible:ring-2 focus-visible:ring-focus data-pressed:bg-selected data-pressed:text-fg"
        >
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
