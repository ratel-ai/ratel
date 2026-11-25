"use client";

import { cn } from "@ratel/design-system/cn";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { usePeek } from "@ratel/design-system/panel";
import { Tooltip } from "@ratel/design-system/tooltip";
import { ChevronRight } from "lucide-react";
import { GROUP_COLOR } from "@/components/console/hallucinations/copy";
import { percent, plural } from "@/components/console/sentiment/copy";
import { REVEAL_ROW, Reveal, useReveal } from "@/components/console/sentiment/reveal";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import { formatRelativeTime, formatTimestamp } from "@/lib/synthesis/traces/v2/format";
import type { GroupView, KindView } from "@/lib/views/health/hallucinations/page-links";
import { KIND_PEEK } from "@/lib/views/health/hallucinations/paths";

/**
 * The hallucinations in one table, by group: each group is a heading row with
 * its totals, then its kinds with their occurrences, their share of every
 * hallucination, the turns and sessions they touched and when one was last
 * seen. A heading row folds its group (folded by default; one group alone
 * starts open); a kind opens in the Panel (`?open=`).
 */

type Line =
  | { kind: "group"; group: GroupView; open: boolean }
  | { kind: "row"; row: KindView; shown: boolean };

export function KindTable({ groups, now }: { groups: readonly GroupView[]; now: string }) {
  const folds = useReveal(groups.length === 1);
  const peek = usePeek(KIND_PEEK);
  const lines: Line[] = groups.flatMap((group): Line[] => {
    const shown = folds.isOpen(group.group);
    return [
      { kind: "group", group, open: shown },
      ...(folds.isMounted(group.group) ? group.kinds : []).map(
        (row): Line => ({ kind: "row", row, shown }),
      ),
    ];
  });
  const totals = (line: Line) => (line.kind === "group" ? line.group : line.row);
  const columns: Column<Line>[] = [
    {
      id: "kind",
      header: "Group and kind",
      cell: (line) =>
        line.kind === "group" ? (
          <GroupHeading
            group={line.group}
            folded={!line.open}
            onFold={() => folds.toggle(line.group.group)}
          />
        ) : (
          <Kind row={line.row} />
        ),
    },
    {
      id: "occurrences",
      header: "Occurrences",
      align: "right",
      width: "6.5rem",
      cell: (line) => (
        <span
          className={cn("tabular-nums", line.kind === "group" ? "font-medium text-fg" : "text-fg")}
        >
          {formatCount(totals(line).occurrences)}
        </span>
      ),
    },
    {
      id: "share",
      header: (
        <Tooltip content="Of every hallucination in this window">
          <span>Share</span>
        </Tooltip>
      ),
      align: "right",
      width: "4.5rem",
      cell: (line) => (
        <span className="text-fg-muted tabular-nums">{percent(totals(line).share)}</span>
      ),
    },
    {
      id: "turns",
      header: "Turns",
      align: "right",
      width: "4.5rem",
      hiddenBelow: "sm",
      cell: (line) => (
        <span className="text-fg-muted tabular-nums">{formatCount(totals(line).turns)}</span>
      ),
    },
    {
      id: "sessions",
      header: "Sessions",
      align: "right",
      width: "5rem",
      hiddenBelow: "md",
      cell: (line) => (
        <span className="text-fg-muted tabular-nums">{formatCount(totals(line).sessions)}</span>
      ),
    },
    {
      id: "lastSeen",
      header: "Last seen",
      align: "right",
      width: "6.5rem",
      hiddenBelow: "sm",
      cell: (line) => {
        const at = totals(line).lastSeen;
        return at ? (
          <time
            dateTime={at}
            title={formatTimestamp(at)}
            className="whitespace-nowrap text-fg-muted tabular-nums"
          >
            {formatRelativeTime(at, now)}
          </time>
        ) : null;
      },
    },
  ];
  return (
    <DataTable
      caption={`Hallucinations by group: ${plural(groups.length, "group")}, ${plural(
        groups.reduce((sum, group) => sum + group.kinds.length, 0),
        "kind",
      )}`}
      columns={columns.map((column) => ({
        ...column,
        cell: (line: Line) =>
          line.kind === "group" ? (
            column.cell(line)
          ) : (
            <Reveal shown={line.shown} align={column.align}>
              {column.cell(line)}
            </Reveal>
          ),
      }))}
      rows={lines}
      rowKey={(line) => (line.kind === "group" ? `group:${line.group.group}` : line.row.kind)}
      selectedKey={peek.id}
      rowClassName={(line) =>
        cn(
          line.kind === "group" && "bg-raised",
          line.kind === "row" && REVEAL_ROW,
          line.kind === "row" && !line.shown && "[&>td]:border-b-transparent",
        )
      }
      onRowOpen={(line) => {
        if (line.kind === "group") folds.toggle(line.group.group);
        else peek.open(line.row.kind);
      }}
      // The page shows its own good news when nothing was found: the table is never empty.
      empty={null}
    />
  );
}

function GroupHeading({
  group,
  folded,
  onFold,
}: {
  group: GroupView;
  folded: boolean;
  onFold: () => void;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 py-1.5">
      <button
        type="button"
        aria-expanded={!folded}
        aria-label={folded ? `Show the kinds of ${group.label}` : `Fold ${group.label}`}
        onClick={(event) => {
          event.stopPropagation();
          onFold();
        }}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-fg-subtle outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3.5 transition-transform duration-200 motion-reduce:transition-none",
            !folded && "rotate-90",
          )}
        />
      </button>
      <span aria-hidden className={cn("size-2 shrink-0 rounded-[2px]", GROUP_COLOR[group.group])} />
      <Tooltip content={group.meaning}>
        <span className="font-semibold text-fg">{group.label}</span>
      </Tooltip>
      {folded ? (
        <span className="text-xs text-fg-subtle">{plural(group.kinds.length, "kind")} folded</span>
      ) : null}
    </span>
  );
}

function Kind({ row }: { row: KindView }) {
  return (
    <span className="flex min-w-0 pl-7">
      <Tooltip content={row.meaning}>
        <span className="text-fg">{row.label}</span>
      </Tooltip>
    </span>
  );
}
