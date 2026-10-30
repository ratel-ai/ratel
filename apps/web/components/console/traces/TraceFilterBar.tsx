"use client";

import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { FilterBar, FilterChip, SearchInput } from "@ratel/design-system/filter-bar";
import { Popover, PopoverContent, PopoverTrigger } from "@ratel/design-system/popover";
import { Check, ChevronLeft, ChevronRight, ListFilter } from "lucide-react";
import { type ReactNode, useEffect, useEffectEvent, useMemo, useReducer, useState } from "react";
import type { TraceFacets } from "@/lib/synthesis/traces/queries";
import {
  type FilterField,
  filterChips,
  filterFields,
  hasFilters,
  searchText,
  type TraceTab,
  withFilterToggled,
  withoutChip,
  withoutFilters,
  withSearchText,
} from "@/lib/synthesis/traces/v2/filters";
import { formatInteger } from "@/lib/synthesis/traces/v2/format";
import {
  needsUrlSync,
  searchBoxReducer,
  searchBoxState,
  searchToSend,
} from "@/lib/synthesis/traces/v2/search-box";
import type { SearchUpdate } from "./navigation";

/** How long typing rests before the list follows it. */
const SEARCH_DEBOUNCE_MS = 300;
/** Values a field lists before its own search box appears. */
const SEARCHABLE_AFTER = 8;

const SEARCH_PLACEHOLDER: Readonly<Record<TraceTab, string>> = {
  runs: "Search by name…",
  spans: "Search steps by name…",
  logs: "Search logs by name…",
};

/**
 * The one filter row for a Traces tab (DESIGN.md, Lists): search, the active
 * filters as chips, and "Filter" to add one from the values seen in the
 * window. Replaces v1's form, facet rail and inline brush, which filtered the
 * same records three ways.
 */
export function TraceFilterBar({
  tab,
  search,
  pending,
  facets,
  onSearchChange,
  end,
}: {
  tab: TraceTab;
  /** The current query string, with its `?`. */
  search: string;
  /** A navigation is loading, so a value the search box sent may not be in `search` yet. */
  pending: boolean;
  facets: Pick<
    TraceFacets,
    "model" | "tool" | "service" | "environment" | "experiment" | "arm" | "name"
  >;
  /** Applies a change. Every change here is a function of the newest query asked for, never a stale copy. */
  onSearchChange: (next: SearchUpdate, options?: { replace?: boolean }) => void;
  end?: ReactNode;
}) {
  const chips = useMemo(() => filterChips(tab, search), [tab, search]);
  const fields = useMemo(() => filterFields(tab, search, facets), [tab, search, facets]);
  const filtered = hasFilters(tab, search);

  // What the box shows is kept apart from what the URL says (lib/traces/v2/
  // search-box.ts): typing never waits for a navigation to land, and the URL
  // only overwrites the text when it moved for another reason.
  const urlText = searchText(tab, search);
  const [box, dispatch] = useReducer(searchBoxReducer, urlText, searchBoxState);
  if (needsUrlSync(box, urlText, !pending))
    dispatch({ type: "url", value: urlText, settled: !pending });

  const send = (value: string) => {
    dispatch({ type: "sent", value });
    onSearchChange((current) => withSearchText(tab, current, value), { replace: true });
  };
  const sendTyped = useEffectEvent(() => {
    const value = searchToSend(box);
    if (value !== null) send(value);
  });
  // Typing narrows the list once it rests. Every keystroke, and every change
  // from outside, restarts the wait, so a stale fragment is never sent.
  useEffect(() => {
    if (searchToSend(box) === null) return;
    const timer = setTimeout(() => sendTyped(), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [box]);

  return (
    <FilterBar
      search={
        <NameSearch
          text={box.text}
          placeholder={SEARCH_PLACEHOLDER[tab]}
          onType={(text) => dispatch({ type: "typed", text })}
          onSubmit={() => {
            const value = searchToSend(box);
            if (value !== null) send(value);
          }}
        />
      }
      chips={
        <>
          {chips.map((chip) => (
            <FilterChip
              key={chip.key}
              field={chip.field}
              value={chip.value}
              onRemove={() => onSearchChange((current) => withoutChip(current, chip))}
            />
          ))}
        </>
      }
      addFilter={
        <>
          <AddFilter
            fields={fields}
            onToggle={(field, value) =>
              onSearchChange((current) => withFilterToggled(tab, current, field, value))
            }
          />
          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                dispatch({ type: "cleared" });
                onSearchChange((current) => withoutFilters(tab, current));
              }}
            >
              Clear filters
            </Button>
          ) : null}
        </>
      }
      end={end}
    />
  );
}

/** Typing narrows the list once it rests; Enter applies at once. */
function NameSearch({
  text,
  placeholder,
  onType,
  onSubmit,
}: {
  text: string;
  placeholder: string;
  onType: (text: string) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      role="search"
      className="w-full max-w-64"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <SearchInput
        value={text}
        label={placeholder.replace("…", "")}
        placeholder={placeholder}
        onValueChange={onType}
        className="max-w-none"
      />
    </form>
  );
}

/**
 * "Filter": pick a field, then its values. Fields and values come from the
 * window's facets; a picked value shows a check and picking it again removes
 * it.
 */
function AddFilter({
  fields,
  onToggle,
}: {
  fields: readonly FilterField[];
  onToggle: (field: FilterField["id"], value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [fieldId, setFieldId] = useState<FilterField["id"] | null>(null);
  const [query, setQuery] = useState("");
  const field = fields.find((item) => item.id === fieldId) ?? null;
  const options = useMemo(() => {
    if (!field) return [];
    const needle = query.trim().toLowerCase();
    return needle
      ? field.options.filter((option) => option.label.toLowerCase().includes(needle))
      : field.options;
  }, [field, query]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setFieldId(null);
          setQuery("");
        }
      }}
    >
      <PopoverTrigger render={<Button variant="ghost" size="sm" />}>
        <ListFilter aria-hidden />
        Filter
      </PopoverTrigger>
      <PopoverContent className="w-72 p-1" align="start">
        {field ? (
          <div className="flex flex-col">
            <div className="flex items-center gap-1 px-1 pt-0.5 pb-1">
              <Button
                variant="ghost"
                size="sm"
                className="px-1.5"
                onClick={() => {
                  setFieldId(null);
                  setQuery("");
                }}
              >
                <ChevronLeft aria-hidden />
                {field.label}
              </Button>
            </div>
            {field.options.length > SEARCHABLE_AFTER ? (
              <input
                type="search"
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder={`Find a ${field.label.toLowerCase()}…`}
                aria-label={`Find a ${field.label.toLowerCase()}`}
                className="mx-1 mb-1 h-8 rounded-md border border-line-strong bg-app px-2.5 text-ui text-fg outline-none placeholder:text-fg-faint focus-visible:border-line-active focus-visible:ring-2 focus-visible:ring-focus/40 max-md:text-base"
              />
            ) : null}
            <ul aria-label={`${field.label} values`} className="max-h-72 overflow-y-auto">
              {options.length === 0 ? (
                <li className="px-2 py-2 text-ui text-fg-subtle">No values match</li>
              ) : (
                options.map((option) => (
                  <li key={option.value}>
                    <button
                      type="button"
                      aria-pressed={option.selected}
                      onClick={() => {
                        onToggle(field.id, option.value);
                        setOpen(false);
                        setFieldId(null);
                        setQuery("");
                      }}
                      className={cn(
                        "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-ui text-fg outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset",
                      )}
                    >
                      <Check
                        aria-hidden
                        className={cn(
                          "size-3.5 shrink-0",
                          option.selected ? "text-fg" : "invisible",
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate" title={option.label}>
                        {option.label}
                      </span>
                      {option.count !== undefined ? (
                        <span className="shrink-0 text-xs text-fg-subtle tabular-nums">
                          {formatInteger(option.count)}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        ) : (
          <ul aria-label="Filter by">
            {fields.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (
                      item.options.length === 1 &&
                      (item.id === "status" || item.id === "unlinked")
                    ) {
                      onToggle(item.id, item.options[0].value);
                      setOpen(false);
                      return;
                    }
                    setFieldId(item.id);
                  }}
                  className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-ui text-fg outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.id === "status" || item.id === "unlinked" ? (
                    <span className="text-xs text-fg-subtle">
                      {item.options[0].selected ? "On" : item.options[0].label}
                    </span>
                  ) : (
                    <ChevronRight aria-hidden className="size-3.5 text-fg-subtle" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
