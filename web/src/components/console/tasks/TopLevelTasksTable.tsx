"use client";

import { type Column, DataTable } from "@ratel/design-system/data-table";
import { DotSpark } from "@ratel/design-system/dot-matrix";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TaskDot, TaskStatusBadge } from "@/components/console/tasks/TaskMarks";
import { formatCount, formatShare } from "@/lib/views/tasks/format";
import type { TaskLiveScore } from "@/lib/views/tasks/live-scores";
import type { TaskRow } from "@/lib/views/tasks/model";
import { topLevelTasksHref } from "@/lib/views/tasks/paths";

/** Show one row per task. Scores are absent when cloud-eval-gate is off. */
export function TopLevelTasksTable({
  projectId,
  rows,
  scores,
}: {
  projectId: string;
  rows: readonly TaskRow[];
  scores?: ReadonlyMap<string, TaskLiveScore> | null;
}) {
  const router = useRouter();
  const columns: Column<TaskRow>[] = [
    {
      id: "task",
      header: "Task",
      cell: (task) => (
        <span className="flex min-w-0 items-center gap-2" data-task-row={task.id}>
          <TaskDot color={task.color} />
          <Link
            href={topLevelTasksHref(projectId, task.id)}
            className="truncate rounded-sm font-medium text-fg outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
          >
            {task.name}
          </Link>
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      width: "7rem",
      cell: (task) => <TaskStatusBadge status={task.status} />,
    },
    {
      id: "runs",
      header: "Runs",
      align: "right",
      width: "6rem",
      hiddenBelow: "md",
      cell: (task) => formatCount(task.runs),
    },
  ];
  if (scores !== undefined) {
    columns.push(
      {
        id: "score",
        header: "Live score",
        align: "right",
        width: "9rem",
        cell: (task) => {
          const score = scores?.get(task.id);
          return (
            <span className="inline-flex flex-col py-1" data-task-score={task.id}>
              <span>
                {scores === null
                  ? "Unavailable"
                  : score?.rate == null
                    ? "Not scored today"
                    : formatShare(score.rate)}
              </span>
              {score?.rate != null ? (
                <span className="text-xs text-fg-subtle">
                  {formatCount(score.runs)} runs today (UTC)
                </span>
              ) : null}
            </span>
          );
        },
      },
      {
        id: "history",
        header: "14 days",
        align: "right",
        width: "6rem",
        hiddenBelow: "sm",
        cell: (task) => {
          const history = scores?.get(task.id)?.history;
          return history?.some((rate) => rate !== null) ? (
            <DotSpark
              values={history}
              highlightLast={false}
              label={`Daily score, oldest first, UTC: ${history.map((rate) => (rate === null ? "not scored" : formatShare(rate))).join(", ")}`}
            />
          ) : (
            <span className="text-fg-faint">–</span>
          );
        },
      },
    );
  }
  return (
    <DataTable
      caption="Tasks, busiest first"
      columns={columns}
      rows={rows}
      rowKey={(task) => task.id}
      onRowOpen={(task) => router.push(topLevelTasksHref(projectId, task.id))}
    />
  );
}
