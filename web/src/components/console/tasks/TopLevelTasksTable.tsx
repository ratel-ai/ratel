"use client";

import { type Column, DataTable } from "@ratel/design-system/data-table";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TaskDot, TaskStatusBadge } from "@/components/console/tasks/TaskMarks";
import { formatCount } from "@/lib/views/tasks/format";
import type { TaskRow } from "@/lib/views/tasks/model";
import { topLevelTasksHref } from "@/lib/views/tasks/paths";

/** Show one row per task. */
export function TopLevelTasksTable({
  projectId,
  rows,
}: {
  projectId: string;
  rows: readonly TaskRow[];
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
