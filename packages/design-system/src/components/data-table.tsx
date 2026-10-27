"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import Link from "next/link";
import { type KeyboardEvent, type MouseEvent, type ReactNode, useRef, useState } from "react";
import { cn } from "../cn";
import { eventFromInside, isTypingTarget, stepIndex } from "./peek";
import { Skeleton } from "./states";
import {
  nextSortDirection,
  rovingIndex,
  rowKeyAction,
  type SortDirection,
  type TableSort,
} from "./table-model";

export type { SortDirection, TableSort } from "./table-model";

export type Column<T> = {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Numbers align right and use tabular figures. */
  align?: "left" | "right";
  /** CSS width ("8rem", "40%"). One flexible column has none. */
  width?: string;
  /** Makes the header a sort link; sort lives in the URL. */
  sortHref?: (direction: SortDirection) => string;
  /**
   * Sorts in place instead of navigating, for tables whose rows are already
   * on the client: a plain click calls this (which should write the URL
   * through the History API), while the href still works in a new tab.
   */
  onSort?: (direction: SortDirection) => void;
  /** First direction when this column is not the current sort. Numbers default to descending. */
  defaultDirection?: SortDirection;
  /** Leaves the whole column out (header and cells) below this breakpoint, so a phone keeps the columns that matter. */
  hiddenBelow?: "sm" | "md" | "lg";
  className?: string;
  /** Classes for the column's header cell, e.g. to hide the whole column on narrow screens with its cells. */
  headerClassName?: string;
};

// Written out whole so the class names exist at build time.
const HIDDEN_BELOW = { sm: "max-sm:hidden", md: "max-md:hidden", lg: "max-lg:hidden" } as const;

export type DataTableProps<T> = {
  /** Accessible name for the table (visually hidden). */
  caption: string;
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** Opens a row (usually the Panel). Click and Enter call it; `j` and `k` move between rows. */
  onRowOpen?: (row: T, index: number) => void;
  /**
   * Toggles a row's selection from the keyboard: Space or `x` on a focused
   * row. With it, a selection checkbox in the row stays out of the tab order.
   */
  onRowToggle?: (row: T, index: number) => void;
  /** The row whose Panel is open. */
  selectedKey?: string | null;
  sort?: TableSort;
  loading?: boolean;
  /** Shown in place of the rows when there are none (an EmptyState). */
  empty?: ReactNode;
  density?: "default" | "compact";
  className?: string;
};

const INTERACTIVE = "a, button, input, select, textarea, label, [role='button'], [role='checkbox']";

/** Every list of records (DESIGN.md, Lists). */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  onRowOpen,
  onRowToggle,
  selectedKey = null,
  sort,
  loading = false,
  empty,
  density = "default",
  className,
}: DataTableProps<T>) {
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);
  const [focusIndex, setFocusIndex] = useState(0);
  const rowHeight = density === "compact" ? "h-8" : "h-9";
  const tabStop = rovingIndex(focusIndex, rows.length);

  function focusRow(index: number) {
    if (index < 0) return;
    setFocusIndex(index);
    rowRefs.current[index]?.focus();
  }

  function onRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, row: T, index: number) {
    if (!eventFromInside(event)) return;
    if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
    const action = rowKeyAction(event.key, {
      onRow: event.target === event.currentTarget,
      canOpen: Boolean(onRowOpen),
      canToggle: Boolean(onRowToggle),
    });
    if (!action) return;
    event.preventDefault();
    if (action === "next") focusRow(stepIndex(index, 1, rows.length));
    else if (action === "previous") focusRow(stepIndex(index, -1, rows.length));
    else if (action === "open") onRowOpen?.(row, index);
    else onRowToggle?.(row, index);
  }

  function onRowClick(event: MouseEvent<HTMLTableRowElement>, row: T, index: number) {
    if (!onRowOpen || !eventFromInside(event)) return;
    if ((event.target as Element).closest(INTERACTIVE)) return;
    setFocusIndex(index);
    onRowOpen(row, index);
  }

  return (
    // Only narrow screens scroll the table sideways: a scroll container would
    // become the sticky header's frame and stop it sticking to the page.
    <div className={cn("w-full max-md:overflow-x-auto", className)}>
      <table className="w-full border-separate border-spacing-0 text-ui">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => {
              const sorted = sort?.id === column.id ? sort.direction : null;
              const align = column.align === "right" ? "text-right" : "text-left";
              return (
                <th
                  key={column.id}
                  scope="col"
                  aria-sort={
                    sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined
                  }
                  style={column.width ? { width: column.width } : undefined}
                  className={cn(
                    "sticky top-0 z-sticky h-9 border-b border-line bg-app px-3 text-xs font-medium whitespace-nowrap text-fg-subtle",
                    align,
                    column.hiddenBelow && HIDDEN_BELOW[column.hiddenBelow],
                    column.headerClassName,
                  )}
                >
                  {column.sortHref ? (
                    <Link
                      href={column.sortHref(
                        nextSortDirection(
                          column.id,
                          sort,
                          column.defaultDirection ?? (column.align === "right" ? "desc" : "asc"),
                        ),
                      )}
                      scroll={false}
                      onClick={
                        column.onSort
                          ? (event) => {
                              if (
                                event.metaKey ||
                                event.ctrlKey ||
                                event.shiftKey ||
                                event.altKey ||
                                event.button !== 0
                              )
                                return;
                              event.preventDefault();
                              column.onSort?.(
                                nextSortDirection(
                                  column.id,
                                  sort,
                                  column.defaultDirection ??
                                    (column.align === "right" ? "desc" : "asc"),
                                ),
                              );
                            }
                          : undefined
                      }
                      className={cn(
                        "inline-flex items-center gap-1 rounded outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus",
                        sorted && "text-fg",
                      )}
                    >
                      {column.header}
                      {sorted === "asc" ? <ArrowUp className="size-3" aria-hidden /> : null}
                      {sorted === "desc" ? <ArrowDown className="size-3" aria-hidden /> : null}
                    </Link>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: 6 }, (_, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity.
                <tr key={`skeleton-${index}`} aria-hidden>
                  {columns.map((column) => (
                    <td
                      key={column.id}
                      className={cn(
                        rowHeight,
                        "border-b border-line px-3",
                        column.hiddenBelow && HIDDEN_BELOW[column.hiddenBelow],
                      )}
                    >
                      <Skeleton
                        className={cn("h-3", column.align === "right" ? "ml-auto w-12" : "w-3/4")}
                      />
                    </td>
                  ))}
                </tr>
              ))
            : null}
          {!loading && rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="border-b border-line">
                {empty}
              </td>
            </tr>
          ) : null}
          {!loading
            ? rows.map((row, index) => {
                const key = rowKey(row);
                const selected = selectedKey === key;
                return (
                  <tr
                    key={key}
                    ref={(element) => {
                      rowRefs.current[index] = element;
                    }}
                    tabIndex={index === tabStop ? 0 : -1}
                    aria-current={selected ? "true" : undefined}
                    aria-keyshortcuts={onRowToggle ? "x" : undefined}
                    data-selected={selected || undefined}
                    onKeyDown={(event) => onRowKeyDown(event, row, index)}
                    onClick={(event) => onRowClick(event, row, index)}
                    className={cn(
                      "outline-none transition-colors duration-120 focus-visible:bg-hover focus-visible:shadow-[inset_2px_0_0_var(--ds-focus)]",
                      onRowOpen && "cursor-pointer hover:bg-hover",
                      selected && "bg-selected hover:bg-selected",
                    )}
                  >
                    {columns.map((column) => (
                      <td
                        key={column.id}
                        className={cn(
                          rowHeight,
                          "border-b border-line px-3 text-fg",
                          column.align === "right" && "text-right tabular-nums",
                          column.hiddenBelow && HIDDEN_BELOW[column.hiddenBelow],
                          column.className,
                        )}
                      >
                        {column.cell(row)}
                      </td>
                    ))}
                  </tr>
                );
              })
            : null}
        </tbody>
      </table>
    </div>
  );
}
