"use client";

import { Search, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../cn";

/**
 * Filters for a list, in one row above it (DESIGN.md, Lists): search on the
 * left, active filters as chips, and the time window or view options on the
 * right. The page owns the state and keeps it in the URL.
 */
export function FilterBar({
  search,
  chips,
  addFilter,
  end,
  className,
}: {
  search?: ReactNode;
  chips?: ReactNode;
  /** The "Filter" menu that adds a chip. */
  addFilter?: ReactNode;
  /** Right side: DateRange, view options. */
  end?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Filters"
      className={cn("flex flex-wrap items-center gap-2", className)}
    >
      {search}
      {chips}
      {addFilter}
      {end ? <div className="ml-auto flex items-center gap-2">{end}</div> : null}
    </div>
  );
}

export function SearchInput({
  value,
  onValueChange,
  placeholder = "Search…",
  label = "Search",
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  className?: string;
}) {
  return (
    <div className={cn("relative w-full max-w-64", className)}>
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-subtle"
      />
      <input
        type="search"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        className="h-8 w-full rounded-md border border-line-strong bg-app pr-2.5 pl-8 text-ui text-fg outline-none placeholder:text-fg-faint hover:border-line-active focus-visible:border-line-active focus-visible:ring-2 focus-visible:ring-focus/40 max-md:text-base [&::-webkit-search-cancel-button]:hidden"
      />
    </div>
  );
}

/** One active filter: "Status is failed", removable. */
export function FilterChip({
  field,
  value,
  onRemove,
}: {
  field: string;
  value: ReactNode;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-md border border-line-strong bg-raised pr-0.5 pl-2 text-ui">
      <span className="text-fg-subtle">{field}</span>
      <span className="font-medium text-fg">{value}</span>
      <button
        type="button"
        aria-label={`Remove ${field} filter`}
        onClick={onRemove}
        className="inline-flex size-6 items-center justify-center rounded text-fg-subtle outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
      >
        <X className="size-3" aria-hidden />
      </button>
    </span>
  );
}
