"use client";

import { StatusDot } from "@ratel/design-system/badge";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { ToolBadges, TruncatedText } from "@/components/console/traces/cells";
import {
  formatClock,
  formatDuration,
  formatInteger,
  formatMoney,
} from "@/lib/synthesis/traces/v2/format";
import { TURN_NOUN } from "@/lib/synthesis/traces/v2/run-noun";
import type { SessionRow } from "@/lib/synthesis/traces-sessions/sessions";
import {
  groupSessionsByDay,
  type SessionColumn,
  sessionRowKey,
  sessionTitle,
} from "@/lib/synthesis/traces-sessions/view";
import type { RunningSearchExperiment } from "./SessionsView";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * The sessions, one table per UTC day of their latest activity: what was
 * asked first (or the intent, with text off), Failed when it failed, the
 * turns, the time it took and when it started. Tools, tokens and cost show
 * only when toggled on. A row in the running search experiment says so.
 */
export function SessionsTable({
  rows,
  columns,
  experiment,
  openKey,
  onOpen,
}: {
  rows: readonly SessionRow[];
  columns: readonly SessionColumn[];
  experiment: RunningSearchExperiment | null;
  openKey: string | null;
  onOpen: (key: string) => void;
}) {
  const noun = TURN_NOUN;
  const tableColumns: Column<SessionRow>[] = [
    {
      id: "ask",
      header: "What they asked",
      // The flexible column: it takes the room left and truncates inside it.
      className: "w-full max-w-0 min-w-48",
      cell: (row) => {
        const title = sessionTitle(row);
        return (
          <span className="flex min-w-0 items-center gap-2" data-title-source={title.source}>
            <TruncatedText
              text={title.text}
              className={
                title.source === "id"
                  ? "text-fg-muted"
                  : title.source === "intent"
                    ? "text-fg-muted"
                    : "text-fg"
              }
            />
            {experiment && row.experiment?.name === experiment.name ? (
              <span
                className="shrink-0 rounded-sm border border-line px-1 text-xs text-fg-subtle"
                title={`Experiment ${experiment.name}${row.experiment.arm ? `, arm ${row.experiment.arm}` : ""}`}
                data-row-experiment
              >
                {row.experiment.arm ?? "Experiment"}
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      id: "failed",
      header: <span className="sr-only">Failed</span>,
      width: "6rem",
      className: "whitespace-nowrap",
      cell: (row) =>
        row.failed ? <StatusDot tone="danger" label="Failed" className="text-xs" /> : null,
    },
    {
      id: "turns",
      header: "Turns",
      align: "right",
      width: "4.5rem",
      cell: (row) =>
        row.kind === "run" ? (
          <span className="text-fg-subtle" title={`A ${noun.lower} with no session`}>
            1
          </span>
        ) : (
          formatInteger(row.turns)
        ),
    },
    ...(columns.includes("tools")
      ? [
          {
            id: "tools",
            header: "Tools",
            width: "17rem",
            className: "max-w-[17rem]",
            cell: (row: SessionRow) => <ToolBadges tools={row.tools} />,
          },
        ]
      : []),
    ...(columns.includes("tokens")
      ? [
          {
            id: "tokens",
            header: "Tokens",
            align: "right" as const,
            width: "6.5rem",
            cell: (row: SessionRow) => formatInteger(row.tokens),
          },
        ]
      : []),
    // RC-472: a session row always shows what it cost.
    {
      id: "cost",
      header: "Cost",
      align: "right" as const,
      width: "6rem",
      cell: (row: SessionRow) => formatMoney(row.costUsd),
    },
    {
      id: "duration",
      header: "Time",
      align: "right",
      width: "6rem",
      className: "whitespace-nowrap",
      cell: (row) => formatDuration(row.durationMs),
    },
    {
      id: "started",
      header: "Started",
      align: "right",
      width: "5.5rem",
      cell: (row) => <time dateTime={row.startedAt}>{formatClock(row.startedAt)}</time>,
    },
  ];

  return (
    <div className="flex flex-col gap-6" data-sessions-list>
      {groupSessionsByDay(rows).map((group, index) => (
        <section
          key={group.key}
          aria-label={dayName(group.day)}
          data-day={group.day}
          className="flex flex-col gap-1"
        >
          <h3 className="text-xs font-medium text-fg-subtle">{dayName(group.day)}</h3>
          <DataTable
            caption={`Sessions on ${dayName(group.day)}`}
            columns={tableColumns}
            rows={group.rows}
            rowKey={sessionRowKey}
            onRowOpen={(row) => onOpen(sessionRowKey(row))}
            selectedKey={openKey}
            // The column names show once, above the first day. Later days collapse
            // their header row, which keeps its widths so the columns line up.
            className={index > 0 ? "[&_thead_tr]:collapse" : undefined}
          />
        </section>
      ))}
    </div>
  );
}

/** "Sunday 1 November" for a UTC day. */
export function dayName(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return day;
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}
