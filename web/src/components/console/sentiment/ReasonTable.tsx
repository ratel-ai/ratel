"use client";

import { cn } from "@ratel/design-system/cn";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { usePeek } from "@ratel/design-system/panel";
import { Tooltip } from "@ratel/design-system/tooltip";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { money, NO_CAUSE_LABEL, plural, STATUS_COLOR } from "@/components/console/sentiment/copy";
import { ROOT_CAUSE_PEEK, rootCauseKey } from "@/components/console/sentiment/RootCausePanel";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import {
  formatCompact,
  formatDuration,
  formatRelativeTime,
  formatTimestamp,
} from "@/lib/synthesis/traces/v2/format";
import { CAUSE_LABEL, CAUSE_MEANING } from "@/lib/views/traces/sentiment/page-kinds";
import type { ReasonGroupView, ReasonRowView } from "@/lib/views/traces/sentiment/page-links";
import type { SentimentSort } from "@/lib/views/traces/sentiment/page-paths";

/**
 * Why tasks were not completed, and what got in the way of the ones completed
 * after friction, in one table: each reason is a heading row with its totals,
 * then its root causes (a cause and a tool), each counted once per task, with
 * what the trouble cost and took (a task not completed whole, a task completed
 * after friction only its friction). A column header orders the reasons and
 * their root causes alike. A heading row folds its reason; a root cause opens
 * in the Panel (`?open=`), with its sessions and the way to them in Traces.
 */

const QUIET = "text-fg-subtle";

/** The column each sort orders by. `impact` is tasks here. */
const COLUMN: Record<SentimentSort, string> = {
  impact: "tasks",
  sessions: "sessions",
  share: "tasks",
  cost: "cost",
  time: "time",
  recent: "lastSeen",
};

/** How long a reason folds or a root cause's sessions open, in ms; the CSS uses the same. */
const REVEAL_MS = 200;

/**
 * Lines that open and close with a reveal: `shown` is what the eye sees
 * (it animates), and a line stays in the table until it has finished closing.
 */
type Line =
  | { kind: "group"; group: ReasonGroupView; open: boolean }
  | { kind: "row"; row: ReasonRowView; group: ReasonGroupView; shown: boolean };

const SPENT_MEANING =
  "Tokens the model calls used (input and output), the cost on hover. A task not completed counts whole. A task completed after friction counts only its friction: the turns before the one that finished it, and the calls that failed before one worked (their share of the turn's model calls, an estimate).";

export function ReasonTable({
  groups,
  sort,
  sortHrefs,
  costKnown,
  now,
  empty,
}: {
  groups: readonly ReasonGroupView[];
  sort: SentimentSort;
  sortHrefs: Readonly<Record<SentimentSort, string>>;
  /** Model calls were sent with a cost: the cost column can order the list. */
  costKnown: boolean;
  now: string;
  empty: React.ReactNode;
}) {
  // Reasons start folded (one reason alone, as when a filter picked it, starts open); a root cause opens in the Panel.
  const reasons = useReveal(groups.length === 1);
  const peek = usePeek(ROOT_CAUSE_PEEK);
  const lines: Line[] = groups.flatMap((group): Line[] => {
    const shown = reasons.isOpen(group.key);
    return [
      { kind: "group", group, open: shown },
      ...(reasons.isMounted(group.key) ? group.rows : []).map(
        (row): Line => ({ kind: "row", row, group, shown }),
      ),
    ];
  });
  const totals = (line: Line) => (line.kind === "group" ? line.group : line.row);
  const columns: Column<Line>[] = [
    {
      id: "cause",
      header: "Reason and cause",
      cell: (line) =>
        line.kind === "group" ? (
          <GroupHeading
            group={line.group}
            folded={!line.open}
            onFold={() => reasons.toggle(line.group.key)}
          />
        ) : (
          <Cause row={line.row} />
        ),
    },
    {
      id: COLUMN.impact,
      header: "Tasks",
      align: "right",
      width: "3.75rem",
      sortHref: () => sortHrefs.impact,
      cell: (item) => (
        <span
          className={cn("tabular-nums", item.kind === "group" ? "font-medium text-fg" : "text-fg")}
        >
          {formatCount(totals(item).tasks)}
        </span>
      ),
    },
    {
      id: COLUMN.sessions,
      header: "Sessions",
      align: "right",
      width: "5rem",
      hiddenBelow: "md",
      sortHref: () => sortHrefs.sessions,
      cell: (item) => (
        <span className="text-fg-muted tabular-nums">{formatCount(totals(item).sessions)}</span>
      ),
    },
    {
      id: COLUMN.cost,
      header: (
        <Tooltip content={SPENT_MEANING}>
          <span>Tokens</span>
        </Tooltip>
      ),
      align: "right",
      width: "5rem",
      sortHref: () => sortHrefs.cost,
      cell: (item) => {
        const { tokens, costUsd } = totals(item);
        return (
          <span
            className="whitespace-nowrap text-fg-muted tabular-nums"
            title={costKnown && costUsd !== null ? money(costUsd) : undefined}
          >
            {tokens === null ? "Not sent" : formatCompact(tokens)}
          </span>
        );
      },
    },
    {
      id: COLUMN.time,
      header: (
        <Tooltip content={`How long, added up. ${SPENT_MEANING}`}>
          <span>Time</span>
        </Tooltip>
      ),
      align: "right",
      width: "5.5rem",
      sortHref: () => sortHrefs.time,
      cell: (item) => (
        <span className="whitespace-nowrap text-fg-muted tabular-nums">
          {formatDuration(totals(item).timeMs)}
        </span>
      ),
    },
    {
      id: COLUMN.recent,
      header: "Last seen",
      align: "right",
      width: "6.5rem",
      hiddenBelow: "sm",
      sortHref: () => sortHrefs.recent,
      cell: (item) => {
        const at = totals(item).lastSeen;
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
  const rowCount = groups.reduce((sum, group) => sum + group.rows.length, 0);
  return (
    <DataTable
      caption={`Root causes by reason: ${plural(groups.length, "reason")}, ${plural(rowCount, "root cause")}`}
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
      rowKey={(line) =>
        line.kind === "group" ? `reason:${line.group.key}` : rootCauseKey(line.group, line.row)
      }
      selectedKey={peek.id}
      rowClassName={(line) =>
        cn(
          line.kind === "group" && "bg-raised",
          // Revealed lines take their content's height, so it can animate; a closed one drops its rule too.
          line.kind !== "group" &&
            "[&>td]:h-auto [&>td]:transition-[border-color] [&>td]:duration-200",
          line.kind !== "group" && !line.shown && "[&>td]:border-b-transparent",
        )
      }
      onRowOpen={(line) => {
        if (line.kind === "group") reasons.toggle(line.group.key);
        else peek.open(rootCauseKey(line.group, line.row));
      }}
      sort={{ id: COLUMN[sort], direction: "desc" }}
      empty={empty}
    />
  );
}

function GroupHeading({
  group,
  folded,
  onFold,
}: {
  group: ReasonGroupView;
  folded: boolean;
  onFold: () => void;
}) {
  return (
    <span className="flex min-w-0 items-start gap-1.5 py-1.5">
      <button
        type="button"
        aria-expanded={!folded}
        aria-label={folded ? `Show the root causes of ${group.label}` : `Fold ${group.label}`}
        onClick={(event) => {
          event.stopPropagation();
          onFold();
        }}
        className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-fg-subtle outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3.5 transition-transform duration-200 motion-reduce:transition-none",
            !folded && "rotate-90",
          )}
        />
      </button>
      <span className="flex min-w-0 flex-col">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Tooltip content={group.meaning}>
            <span className="font-semibold text-fg">{group.label}</span>
          </Tooltip>
          <span className="inline-flex items-center gap-1.5 text-ui text-fg-muted">
            <span
              aria-hidden
              className={cn("size-2 rounded-[2px]", STATUS_COLOR[group.result].bg)}
            />
            {group.result === "not_completed" ? "Not completed" : "Completed after friction"}
          </span>
          {folded ? (
            <span className="text-xs text-fg-subtle">
              {plural(group.rows.length + group.moreRows, "root cause")} folded
            </span>
          ) : null}
        </span>
        {!folded && group.result === "completed_after_friction" && group.extraTurns > 0 ? (
          <span className="text-xs text-fg-subtle">
            {plural(group.extraTurns, "extra turn")} before these tasks were done
          </span>
        ) : null}
        {!folded && group.moreRows > 0 ? (
          <span className="text-xs text-fg-subtle">
            {plural(group.rows.length + group.moreRows, "root cause")}, the first{" "}
            {formatCount(group.rows.length)} here. Pick the reason above for all of them.
          </span>
        ) : null}
      </span>
    </span>
  );
}

/** A root cause: its cause and, quieter, the tool it happened on. Opens in the Panel with the row. */
function Cause({ row }: { row: ReasonRowView }) {
  return (
    <span className="flex min-w-0 items-baseline gap-2 pl-7">
      {row.cause ? (
        <Tooltip content={CAUSE_MEANING[row.cause]}>
          <span className="text-fg">{CAUSE_LABEL[row.cause]}</span>
        </Tooltip>
      ) : (
        <span className={QUIET}>{NO_CAUSE_LABEL}</span>
      )}
      {row.toolName ? (
        <span className="truncate font-mono text-xs text-fg-subtle" title={row.toolName}>
          {row.toolName}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Which lines are open, and which are still in the table: opening mounts a
 * line closed and opens it on the next frame, so it animates in; closing
 * animates it out and takes it away once `REVEAL_MS` has passed (unless it
 * was opened again meanwhile).
 */
function useReveal(defaultOpen: boolean) {
  const [open, setOpen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [mounted, setMounted] = useState<ReadonlyMap<string, boolean>>(new Map());
  // The close each line is waiting to finish: opening it again cancels the removal.
  const closing = useRef(new Map<string, number>());
  const set = (setter: typeof setOpen, key: string, value: boolean) =>
    setter((current) => new Map(current).set(key, value));
  const isOpen = (key: string) => open.get(key) ?? defaultOpen;
  const isMounted = (key: string) => mounted.get(key) ?? defaultOpen;
  const toggle = (key: string) => {
    if (isOpen(key)) {
      const token = (closing.current.get(key) ?? 0) + 1;
      closing.current.set(key, token);
      set(setOpen, key, false);
      window.setTimeout(() => {
        if (closing.current.get(key) === token) set(setMounted, key, false);
      }, REVEAL_MS);
    } else {
      closing.current.set(key, (closing.current.get(key) ?? 0) + 1);
      set(setMounted, key, true);
      requestAnimationFrame(() => requestAnimationFrame(() => set(setOpen, key, true)));
    }
  };
  return { isOpen, isMounted, toggle };
}

/** A cell's content, grown from no height to its own (and back) as its line opens and closes. */
function Reveal({
  shown,
  align,
  children,
}: {
  shown: boolean;
  align?: "left" | "right";
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
        shown ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div className={cn("flex min-h-9 items-center", align === "right" && "justify-end")}>
          {children}
        </div>
      </div>
    </div>
  );
}
