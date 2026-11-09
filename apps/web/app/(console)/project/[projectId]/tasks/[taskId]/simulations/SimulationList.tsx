"use client";

import { type Column, DataTable } from "@ratel/design-system/data-table";
import { EmptyState } from "@ratel/design-system/states";
import Link from "next/link";
import type { TaskSimulationListRow } from "@/lib/views/task-evals/simulation-page";
import { RunTaskSimulationButton, SimulationPoller, SimulationStatus } from "./SimulationControls";

export function SimulationList({
  projectId,
  taskId,
  rows,
}: {
  projectId: string;
  taskId: string;
  rows: TaskSimulationListRow[];
}) {
  const columns: Column<TaskSimulationListRow>[] = [
    {
      id: "fix",
      header: "Fix",
      cell: (row) => (
        <div className="flex flex-col gap-1 py-2">
          <Link
            className="rounded-md text-ui font-medium text-fg outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
            href={`/project/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/simulations/${encodeURIComponent(row.fixId)}`}
          >
            {row.title}
          </Link>
          <span className="text-xs text-fg-subtle">{row.why}</span>
        </div>
      ),
    },
    {
      id: "latest",
      header: "Latest simulation",
      cell: (row) =>
        row.drafting ? (
          <span className="text-ui text-fg-muted">Preparing draft…</span>
        ) : (
          <SimulationStatus state={row.state} stale={row.stale} />
        ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (row) => (
        <RunTaskSimulationButton
          scope={{ projectId, taskId, fixId: row.fixId }}
          running={row.state === "running" || row.drafting}
          compact
        />
      ),
    },
  ];
  return (
    <>
      <SimulationPoller active={rows.some((row) => row.state === "running" || row.drafting)} />
      <DataTable
        caption="Fixes for this task"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.fixId}
        empty={
          <EmptyState
            title="No fixes for this task"
            description="Fixes appear here when Ratel finds a change for this task."
          />
        }
      />
    </>
  );
}
