"use client";

import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { FilterBar, FilterChip } from "@ratel/design-system/filter-bar";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "@ratel/design-system/menu";
import { ListFilter } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import type {
  FilterChipView,
  FilterOptionView,
  SentimentLinks,
} from "@/lib/views/traces/sentiment/page-links";

const LINK =
  "inline-flex items-center gap-1.5 rounded-sm px-1 text-ui text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus";

/**
 * The filters on Root cause analysis, right above the table they narrow: each
 * active one as a chip that removes itself, an "Add filter" menu (a status, a
 * reason, a cause or a tool, with how many tasks each holds), and a way to
 * clear them all. Every change is a URL, so back and share work.
 */
export function RootCauseFilters({
  filters,
  options,
  clearHref,
}: {
  filters: readonly FilterChipView[];
  options: SentimentLinks["filterOptions"];
  clearHref: string;
}) {
  const router = useRouter();
  const go = (href: string) => router.push(href, { scroll: false });
  const groups: Array<[string, readonly FilterOptionView[]]> = [
    ["Status", options.statuses],
    ["Reason", options.reasons],
    ["Cause", options.causes],
    ["Tool", options.tools],
  ];
  const shown = groups.filter(([, items]) => items.length > 0);
  return (
    <FilterBar
      className="min-h-8"
      chips={filters.map((filter) => (
        <FilterChip
          key={filter.field}
          field={filter.label}
          value={filter.value}
          onRemove={() => go(filter.removeHref)}
        />
      ))}
      addFilter={
        <>
          {shown.length > 0 ? (
            <Menu>
              <MenuTrigger
                className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
                data-root-cause-add-filter=""
              >
                <ListFilter aria-hidden />
                Add filter
              </MenuTrigger>
              <MenuContent className="max-h-96 w-64 overflow-y-auto">
                {shown.map(([label, items], at) => (
                  <div key={label}>
                    {at > 0 ? <MenuSeparator /> : null}
                    <MenuGroup label={label}>
                      {items.map((item) => (
                        <MenuItem key={item.key} onClick={() => go(item.href)}>
                          <span className="flex w-full items-center justify-between gap-3">
                            <span className="truncate">{item.label}</span>
                            <span className="text-xs text-fg-subtle tabular-nums">
                              {formatCount(item.tasks)}
                            </span>
                          </span>
                        </MenuItem>
                      ))}
                    </MenuGroup>
                  </div>
                ))}
              </MenuContent>
            </Menu>
          ) : null}
          {filters.length > 1 ? (
            <Link href={clearHref} scroll={false} className={LINK}>
              Clear filters
            </Link>
          ) : null}
        </>
      }
    />
  );
}
