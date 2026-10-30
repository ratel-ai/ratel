"use client";

import { StatusDot } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { Checkbox } from "@ratel/design-system/checkbox";
import { cn } from "@ratel/design-system/cn";
import { type Column, DataTable, type SortDirection } from "@ratel/design-system/data-table";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { withSort } from "@/lib/synthesis/traces/v2/filters";
import { formatDuration, formatInteger, formatMoney } from "@/lib/synthesis/traces/v2/format";
import { experimentLabel } from "@/lib/synthesis/traces/v2/logs";
import { RUN_STATUS_LABEL, RUN_STATUS_TONE, type RunRow } from "@/lib/synthesis/traces/v2/runs";
import { RelativeTime, ToolBadges, TruncatedText } from "./cells";

export type RunSort = "started" | "duration" | "tokens" | "cost";

/**
 * The Runs list (DESIGN.md, Lists): a row opens the run's Panel (click or
 * Enter, `j` and `k` to move), checkboxes on hover pick two runs to compare
 * (Space or `x` on a focused row does the same), and the sortable columns
 * write the order to the URL.
 */
export function RunsTable({
  rows,
  now,
  pathname,
  search,
  sort,
  showExperiment,
  openId,
  onOpen,
  picked,
  onTogglePick,
  empty,
}: {
  rows: readonly RunRow[];
  now: string;
  pathname: string;
  search: string;
  sort: { id: RunSort; direction: SortDirection };
  showExperiment: boolean;
  openId: string | null;
  onOpen: (row: RunRow) => void;
  picked: readonly string[];
  onTogglePick: (id: string) => void;
  empty?: ReactNode;
}) {
  const sortHref = (id: RunSort) => (direction: SortDirection) =>
    `${pathname}${withSort(search, id, direction)}`;
  const full = picked.length >= 2;
  const columns: Column<RunRow>[] = [
    {
      id: "pick",
      header: <span className="sr-only">Pick to compare</span>,
      width: "2.5rem",
      className: "pr-0",
      cell: (row) => {
        const isPicked = picked.includes(row.id);
        return (
          <span
            className={cn(
              "flex items-center transition-opacity duration-120",
              // Appear on hover or on the focused row, and always on touch
              // screens, which have no hover; stay once anything is picked.
              picked.length === 0 &&
                "opacity-0 focus-within:opacity-100 pointer-coarse:opacity-100 [tr:focus-visible_&]:opacity-100 [tr:hover_&]:opacity-100",
            )}
          >
            {/* Not a tab stop of its own: the row is, and Space or x on it toggles this. */}
            <Checkbox
              aria-label={`Pick ${row.title} to compare`}
              checked={isPicked}
              disabled={full && !isPicked}
              tabIndex={-1}
              onCheckedChange={() => onTogglePick(row.id)}
            />
          </span>
        );
      },
    },
    {
      id: "status",
      header: "Status",
      width: "7.5rem",
      cell: (row) => (
        <StatusDot tone={RUN_STATUS_TONE[row.status]} label={RUN_STATUS_LABEL[row.status]} />
      ),
    },
    {
      id: "run",
      header: "Run",
      // The flexible column: it takes the room left and truncates inside it.
      // Narrow screens scroll the table sideways rather than crush this column.
      className: "w-full max-w-0 min-w-48",
      cell: (row) => <TruncatedText text={row.title} className="text-fg" />,
    },
    {
      id: "started",
      header: "Started",
      width: "8.5rem",
      sortHref: sortHref("started"),
      defaultDirection: "desc",
      cell: (row) => <RelativeTime value={row.startedAt} now={now} />,
    },
    {
      id: "duration",
      header: "Duration",
      align: "right",
      width: "6.5rem",
      sortHref: sortHref("duration"),
      cell: (row) => formatDuration(row.durationMs),
    },
    {
      id: "tools",
      header: "Tools",
      width: "17rem",
      className: "max-w-[17rem]",
      cell: (row) => <ToolBadges tools={row.tools} />,
    },
    {
      id: "tokens",
      header: "Tokens",
      align: "right",
      width: "6.5rem",
      sortHref: sortHref("tokens"),
      cell: (row) => formatInteger(row.tokens),
    },
    {
      id: "cost",
      header: "Cost",
      align: "right",
      width: "6rem",
      sortHref: sortHref("cost"),
      cell: (row) => formatMoney(row.costUsd),
    },
    ...(showExperiment
      ? [
          {
            id: "experiment",
            header: "Experiment",
            width: "12rem",
            className: "max-w-48",
            cell: (row: RunRow) => (
              <TruncatedText
                text={
                  experimentLabel({ experimentName: row.experiment, experimentArm: row.variant }) ??
                  ""
                }
                className="text-fg-muted"
              />
            ),
          } satisfies Column<RunRow>,
        ]
      : []),
  ];

  return (
    <DataTable
      caption="Runs"
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      onRowOpen={onOpen}
      onRowToggle={(row) => onTogglePick(row.id)}
      selectedKey={openId}
      sort={sort}
      empty={empty}
    />
  );
}

/**
 * Bulk actions for the picked runs, floating at the bottom of the list
 * (DESIGN.md, Lists). Comparing needs exactly two.
 */
export function CompareBar({
  picked,
  href,
  onClear,
}: {
  picked: readonly string[];
  href: string | null;
  onClear: () => void;
}) {
  if (picked.length === 0) return null;
  return (
    <div className="pointer-events-none sticky bottom-6 z-sticky flex justify-center">
      <div
        role="region"
        aria-label="Compare runs"
        className="pointer-events-auto flex items-center gap-2 rounded-xl border border-line bg-overlay py-1.5 pr-1.5 pl-4 shadow-overlay"
      >
        <p aria-live="polite" className="text-ui text-fg">
          {picked.length === 2 ? "2 runs picked" : "1 run picked. Pick one more to compare."}
        </p>
        <Button variant="ghost" size="sm" onClick={onClear}>
          Clear
        </Button>
        {href ? (
          <Link href={href} className={buttonVariants({ variant: "primary", size: "sm" })}>
            Compare
          </Link>
        ) : (
          <Button variant="primary" size="sm" disabled>
            Compare
          </Button>
        )}
      </div>
    </div>
  );
}

/** Below the list: how many runs show, and the way to the next page. */
export function ListFooter({
  count,
  noun,
  nextHref,
  firstHref,
}: {
  count: number;
  noun: string;
  nextHref: string | null;
  /** Set when this is not the first page. */
  firstHref: string | null;
}) {
  if (count === 0) return null;
  return (
    <div className="flex min-h-8 items-center gap-3 text-xs text-fg-subtle">
      <span className="tabular-nums">
        {formatInteger(count)} {noun}
        {count === 1 ? "" : "s"} on this page
      </span>
      <span className="ml-auto flex items-center gap-2">
        {firstHref ? (
          <Link
            href={firstHref}
            scroll={false}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            First page
          </Link>
        ) : null}
        {nextHref ? (
          <Link
            href={nextHref}
            scroll={false}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            Next page
            <ArrowRight aria-hidden />
          </Link>
        ) : (
          <span>End of the list</span>
        )}
      </span>
    </div>
  );
}
