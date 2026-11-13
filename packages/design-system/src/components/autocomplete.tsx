"use client";

import { Autocomplete as BaseAutocomplete } from "@base-ui/react/autocomplete";
import { Search } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "../cn";
import { FLOATING_SURFACE } from "./popover";

export type AutocompleteItem = {
  id: string;
  label: string;
  /** A quiet second word on the right: what kind of thing it is. */
  hint?: string;
  icon?: ReactNode;
  /** More words that should find it. */
  keywords?: readonly string[];
};

function matches(item: AutocompleteItem, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase("en-US");
  if (!needle) return true;
  return [item.label, item.hint ?? "", ...(item.keywords ?? [])].some((text) =>
    text.toLocaleLowerCase("en-US").includes(needle),
  );
}

/**
 * Type to find one thing and act on it: jump to a node, open a record. Not a
 * form field: picking an item calls `onPick` and clears the input, so it is
 * ready for the next search. Arrow keys move, Enter picks, Esc closes.
 */
export function Autocomplete({
  items,
  onPick,
  label,
  placeholder = "Search…",
  empty = "Nothing matches",
  limit = 8,
  className,
}: {
  items: readonly AutocompleteItem[];
  onPick: (item: AutocompleteItem) => void;
  /** Accessible name of the input. */
  label: string;
  placeholder?: string;
  empty?: ReactNode;
  limit?: number;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  return (
    <BaseAutocomplete.Root
      items={items as AutocompleteItem[]}
      value={query}
      onValueChange={(next, details) => setQuery(details.reason === "item-press" ? "" : next)}
      itemToStringValue={(item: AutocompleteItem) => item.label}
      filter={(item: AutocompleteItem, value: string) => matches(item, value)}
      limit={limit}
      autoHighlight
    >
      <div className={cn("relative w-full max-w-64", className)}>
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-subtle"
        />
        <BaseAutocomplete.Input
          aria-label={label}
          placeholder={placeholder}
          className="h-8 w-full rounded-md border border-line-strong bg-app pr-2.5 pl-8 text-ui text-fg outline-none placeholder:text-fg-faint hover:border-line-active focus-visible:border-line-active focus-visible:ring-2 focus-visible:ring-focus/40 max-md:text-base"
        />
      </div>
      <BaseAutocomplete.Portal>
        <BaseAutocomplete.Positioner sideOffset={4} className="z-popover">
          <BaseAutocomplete.Popup
            className={cn(FLOATING_SURFACE, "w-(--anchor-width) min-w-64 p-1")}
          >
            <BaseAutocomplete.Empty className="px-2.5 py-3 text-ui text-fg-muted empty:p-0">
              {empty}
            </BaseAutocomplete.Empty>
            <BaseAutocomplete.List className="max-h-[min(20rem,var(--available-height))] overflow-y-auto overscroll-contain outline-none">
              {(item: AutocompleteItem) => (
                <BaseAutocomplete.Item
                  key={item.id}
                  value={item}
                  onClick={() => onPick(item)}
                  className="flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-ui text-fg outline-none select-none data-highlighted:bg-hover [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-fg-subtle"
                >
                  {item.icon}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint ? (
                    <span className="shrink-0 text-xs text-fg-subtle">{item.hint}</span>
                  ) : null}
                </BaseAutocomplete.Item>
              )}
            </BaseAutocomplete.List>
          </BaseAutocomplete.Popup>
        </BaseAutocomplete.Positioner>
      </BaseAutocomplete.Portal>
    </BaseAutocomplete.Root>
  );
}
