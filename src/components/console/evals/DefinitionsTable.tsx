"use client";

import { Badge } from "@ratel/design-system/badge";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { EmptyState } from "@ratel/design-system/states";
import { FlaskConical } from "lucide-react";
import { useRouter } from "next/navigation";
import { evalHref } from "@/lib/views/evals/paths";
import type { DefinitionRow } from "@/lib/views/evals/view";
import { EvalNameCell } from "./EvalNameCell";
import { LastRuns, ResultStatus } from "./marks";

/** The Evals tab's table (C4): eval (with a Suggested label, RC-315), tasks, built-in scorers (RC-658: "Scorers", not "Checks"), last 6 runs, last run. A row opens the eval at its last run. */
export function DefinitionsTable({
  projectId,
  rows,
  filtered,
}: {
  projectId: string;
  rows: readonly DefinitionRow[];
  filtered: boolean;
}) {
  const router = useRouter();
  const columns: Column<DefinitionRow>[] = [
    { id: "eval", header: "Eval", cell: (row) => <EvalNameCell row={row} /> },
    {
      id: "tasks",
      header: "Tasks",
      hiddenBelow: "md",
      cell: (row) => (
        <span className="flex flex-wrap gap-1">
          {row.tasks.map((task) => (
            <Badge key={task.id}>{task.label}</Badge>
          ))}
        </span>
      ),
    },
    { id: "checks", header: "Scorers", width: "7rem", cell: (row) => `${row.checks} built-in` },
    {
      id: "last6",
      header: "Last 6 runs",
      width: "7rem",
      hiddenBelow: "sm",
      cell: (row) => <LastRuns marks={row.last6} />,
    },
    {
      id: "last",
      header: "Last run",
      width: "8rem",
      cell: (row) => <ResultStatus mark={row.last} />,
    },
  ];
  return (
    <DataTable
      caption="Evals"
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      onRowOpen={(row) => router.push(evalHref(projectId, row.id))}
      empty={
        <EmptyState
          icon={FlaskConical}
          title={filtered ? "No evals match these filters" : "No evals yet"}
          description={
            filtered
              ? "Pick another task or show all evals."
              : "Pin a run on a task, or let your tasks suggest runs, to start the suite."
          }
        />
      }
    />
  );
}
