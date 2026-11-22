"use client";

import { type Column, DataTable } from "@ratel/design-system/data-table";
import { EmptyState } from "@ratel/design-system/states";
import { History } from "lucide-react";
import { useRouter } from "next/navigation";
import type { RunListRow } from "@/lib/views/evals/page";
import { evalRunHref, fixSimulationHref } from "@/lib/views/evals/paths";
import { changeText } from "@/lib/views/evals/view";
import { RUN_KIND_LABELS, RunStatus } from "./marks";

const TIME = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

/** The Runs tab (C5): one line per run with its kind, what it ran, the pass count and the change from the run before. */
export function RunsList({ projectId, rows }: { projectId: string; rows: readonly RunListRow[] }) {
  const router = useRouter();
  const columns: Column<RunListRow>[] = [
    {
      id: "kind",
      header: "Kind",
      width: "8rem",
      cell: ({ run }) => <span className="font-medium text-fg">{RUN_KIND_LABELS[run.kind]}</span>,
    },
    {
      id: "suite",
      header: "Ran",
      cell: ({ run, suite }) => (
        <span className="text-fg-muted">
          {run.kind === "simulation"
            ? `Fix ${run.fixId} · ${suite}`
            : `Agent as recorded · ${suite}`}
        </span>
      ),
    },
    {
      id: "result",
      header: "Result",
      width: "12rem",
      cell: ({ run, summary }) =>
        run.status === "completed" ? (
          <span className="tabular-nums">
            <span className="font-semibold text-fg">
              {summary.passed}/{summary.total}
            </span>{" "}
            <span className="text-fg-muted">pass</span>
          </span>
        ) : (
          <RunStatus status={run.status} />
        ),
    },
    {
      id: "change",
      header: "Change",
      width: "12rem",
      cell: ({ run, summary }) =>
        run.status === "completed" ? (
          <span className="flex flex-col">
            <span className={summary.nowFails > 0 ? "text-danger" : "text-success"}>
              {changeText(summary)}
            </span>
            {run.error ? <span className="text-fg-muted">{run.error}</span> : null}
          </span>
        ) : run.status === "failed" ? (
          <span className="text-fg-muted">{run.error ?? "The run failed."}</span>
        ) : null,
    },
    {
      id: "at",
      header: "When",
      width: "9rem",
      align: "right",
      cell: ({ run }) => (
        <span className="text-fg-muted tabular-nums">{TIME.format(run.createdAt)}</span>
      ),
    },
  ];
  return (
    <DataTable
      caption="Eval runs"
      columns={columns}
      rows={rows}
      rowKey={({ run }) => run.id}
      onRowOpen={({ run }) =>
        router.push(
          run.kind === "simulation" && run.fixId
            ? fixSimulationHref(projectId, run.fixId, run.id)
            : evalRunHref(projectId, run.id),
        )
      }
      empty={
        <EmptyState
          icon={History}
          title="No runs yet"
          description="Run all to check every approved eval against the agent as recorded."
        />
      }
    />
  );
}
