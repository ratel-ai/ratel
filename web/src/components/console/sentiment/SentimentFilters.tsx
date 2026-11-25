"use client";

import { FilterBar, FilterChip } from "@ratel/design-system/filter-bar";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FilterChipView } from "@/lib/views/traces/sentiment/page-links";

/** The page's filters as chips; each one's removal is a URL, so back and share work. */

const LINK =
  "inline-flex items-center gap-1.5 rounded-sm px-1 text-ui text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus";

export function SentimentFilters({
  filters,
  clearHref,
}: {
  filters: readonly FilterChipView[];
  clearHref: string;
}) {
  return filters.length > 0 ? <Chips filters={filters} clearHref={clearHref} /> : null;
}

function Chips({ filters, clearHref }: { filters: readonly FilterChipView[]; clearHref: string }) {
  const router = useRouter();
  return (
    <FilterBar
      chips={filters.map((filter) => (
        <FilterChip
          key={filter.field}
          field={filter.label}
          value={filter.value}
          onRemove={() => router.push(filter.removeHref, { scroll: false })}
        />
      ))}
      addFilter={
        filters.length > 1 ? (
          <Link href={clearHref} scroll={false} className={LINK}>
            Clear filters
          </Link>
        ) : null
      }
    />
  );
}
