"use client";

import { type Noun, NounIcon } from "@ratel/design-system/entity";
import { FilterBar, FilterChip } from "@ratel/design-system/filter-bar";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FilterView } from "@/lib/views/health/self-corrections/page-model";

/**
 * The page's filters as chips; each one's removal is a URL, so back and
 * share work. The thing a filter names is one link away: the tool on
 * Catalog, the task's page, the intent on Intents.
 */

const NOUN: Readonly<Record<FilterView["field"], Noun>> = {
  tool: "tool",
  task: "task",
  topic: "intent",
};
const OPEN: Readonly<Record<FilterView["field"], string>> = {
  tool: "Open in Catalog",
  task: "Open task",
  topic: "Open intent",
};
const LINK =
  "inline-flex items-center gap-1.5 rounded-sm px-1 text-ui text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus";

export function Filters({
  filters,
  clearHref,
}: {
  filters: readonly FilterView[];
  clearHref: string;
}) {
  return filters.length > 0 ? <FilterChips filters={filters} clearHref={clearHref} /> : null;
}

function FilterChips({
  filters,
  clearHref,
}: {
  filters: readonly FilterView[];
  clearHref: string;
}) {
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
      end={filters.map((filter) => (
        <Link
          key={filter.field}
          href={filter.href}
          className={LINK}
          data-filter-open={filter.field}
        >
          <NounIcon noun={NOUN[filter.field]} />
          {OPEN[filter.field]}
        </Link>
      ))}
    />
  );
}
