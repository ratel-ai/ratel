"use client";

import { Badge } from "@ratel/design-system/badge";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { EmptyState } from "@ratel/design-system/states";
import { SegmentedControl } from "@ratel/design-system/tabs";
import { FlaskConical } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { evalHref } from "@/lib/views/evals/paths";
import type { RunFilter, RunTable, RunTableRow } from "@/lib/views/evals/view";
import { SCORER_LABELS } from "@/lib/views/task-scorers/labels";
import { CellIcon, CHANGE_TONE, CHANGE_WORDS } from "./marks";

/**
 * One run as a table (C6): a check, cross or dot per scorer, the change from
 * the run before, and All/Failing/Changed in the URL. A simulation's table
 * (E4) passes `rowBase` (its path) to open its two-replay test view at
 * `rowBase/<evalId>`, and its change
 * reads Fixed, Broke or Unverified against today.
 */
export function RunTableView({
  projectId,
  runId,
  table,
  filter,
  rowBase,
}: {
  projectId: string;
  runId: string;
  table: RunTable;
  filter: RunFilter;
  rowBase?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const columns: Column<RunTableRow>[] = [
    {
      id: "eval",
      header: "Eval",
      cell: (row) => (
        <span className="text-fg">
          {row.name}
          {row.attempts ? (
            <span
              className="ml-2 text-fg-muted tabular-nums"
              title="Runs that passed"
              data-attempts
            >
              {row.attempts}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "tasks",
      header: "Tasks",
      width: "15rem",
      hiddenBelow: "lg",
      cell: (row) => (
        <span className="flex flex-wrap gap-1">
          {row.tasks.map((task) => (
            <Badge key={task.id}>{task.label}</Badge>
          ))}
        </span>
      ),
    },
    ...table.columns.map(
      (kind): Column<RunTableRow> => ({
        id: kind,
        header: SCORER_LABELS[kind],
        width: "5.5rem",
        cell: (row) => (
          <CellIcon
            mark={row.cells[kind] ?? "dot"}
            outlined={row.outlined && row.cells[kind] !== "dot"}
          />
        ),
      }),
    ),
    {
      id: "change",
      header: "Change",
      width: "7rem",
      align: "right",
      cell: (row) =>
        row.error ? (
          <span className="text-warning" title={row.error}>
            Could not run
          </span>
        ) : row.change ? (
          <span
            className={CHANGE_TONE[row.change]}
            title={
              row.change === "unverified"
                ? "Passes with the fix, but a tool call got a simulated answer. Not counted as fixed."
                : undefined
            }
          >
            {CHANGE_WORDS[row.change]}
          </span>
        ) : null,
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <SegmentedControl<RunFilter>
          label="Show"
          value={filter}
          onValueChange={(next) =>
            router.push(next === "all" ? pathname : `${pathname}?show=${next}`)
          }
          options={[
            {
              value: "all",
              label: (
                <span className="inline-flex gap-1">
                  All<span className="text-fg-subtle tabular-nums">{table.counts.all}</span>
                </span>
              ),
            },
            {
              value: "failing",
              label: (
                <span className="inline-flex gap-1">
                  Failing<span className="text-fg-subtle tabular-nums">{table.counts.failing}</span>
                </span>
              ),
            },
            {
              value: "changed",
              label: (
                <span className="inline-flex gap-1">
                  Changed<span className="text-fg-subtle tabular-nums">{table.counts.changed}</span>
                </span>
              ),
            },
          ]}
        />
      </div>
      <DataTable
        caption="Results of this run"
        columns={columns}
        rows={table.rows}
        rowKey={(row) => row.evalId}
        onRowOpen={(row) =>
          router.push(
            rowBase
              ? `${rowBase}/${encodeURIComponent(row.evalId)}`
              : evalHref(projectId, row.evalId, { run: runId }),
          )
        }
        empty={
          <EmptyState
            icon={FlaskConical}
            title={
              filter === "all"
                ? "No results yet"
                : filter === "failing"
                  ? "Nothing fails"
                  : "Nothing changed"
            }
            description={
              filter === "all"
                ? "Results appear when the run finishes."
                : "Show all results to see every eval."
            }
          />
        }
      />
    </div>
  );
}
