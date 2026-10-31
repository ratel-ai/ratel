"use client";

import { type Column, DataTable } from "@ratel/design-system/data-table";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { formatTimestamp } from "@/lib/synthesis/traces/format";
import { relativeTimeLabel } from "@/lib/views/intents/adaptive-view";
import type { ExperimentRow } from "@/lib/views/quality/experiments";
import { NO_VALUE, percent } from "@/lib/views/quality/model";

/**
 * Every experiment in the window. A row that compared rankings opens below the
 * table; one that did not opens its existing detail page.
 */
export function ExperimentsTable({
  rows,
  hrefs,
  selected,
  now,
}: {
  rows: readonly ExperimentRow[];
  /** Where each row goes: this tab with the experiment open, or its detail page. */
  hrefs: Record<string, string>;
  selected: string | null;
  now: string;
}) {
  const router = useRouter();
  const at = useMemo(() => new Date(now), [now]);

  const columns: readonly Column<ExperimentRow>[] = [
    {
      id: "name",
      header: "Experiment",
      className: "w-full max-w-0 min-w-40",
      cell: (row) => (
        <span className="block truncate font-medium" title={row.name}>
          {row.name}
        </span>
      ),
    },
    {
      id: "compared",
      header: "Searches compared",
      align: "right",
      width: "9.5rem",
      cell: (row) =>
        row.kind === "ranking" ? (
          row.comparisons.toLocaleString("en-US")
        ) : (
          <span className="text-fg-subtle">{`${row.runs.toLocaleString("en-US")} runs`}</span>
        ),
    },
    {
      id: "first",
      header: "Agreement on first pick",
      align: "right",
      width: "11.5rem",
      cell: (row) => kpiCell(row, row.kpis?.firstPick),
    },
    {
      id: "order",
      header: "Same order",
      align: "right",
      width: "7rem",
      cell: (row) => kpiCell(row, row.kpis?.sameOrder),
    },
    {
      id: "coverage",
      header: "Coverage",
      align: "right",
      width: "6.5rem",
      cell: (row) => kpiCell(row, row.kpis?.coverage),
    },
    {
      id: "seen",
      header: "Last seen",
      align: "right",
      width: "6.5rem",
      cell: (row) => (
        <time
          dateTime={row.lastSeen}
          title={formatTimestamp(row.lastSeen)}
          className="whitespace-nowrap text-fg-muted"
        >
          {relativeTimeLabel(new Date(row.lastSeen), at)}
        </time>
      ),
    },
  ];

  return (
    <DataTable
      caption="Experiments in this window"
      columns={columns}
      rows={rows}
      rowKey={(row) => row.name}
      selectedKey={selected}
      onRowOpen={(row) => {
        const href = hrefs[row.name];
        if (href) router.push(href, { scroll: false });
      }}
    />
  );
}

/** A share for an experiment that compared rankings; a quiet dash for one that did not. */
function kpiCell(row: ExperimentRow, value: number | null | undefined) {
  return row.kind === "ranking" ? (
    percent(value)
  ) : (
    <span className="text-fg-subtle">{NO_VALUE}</span>
  );
}
