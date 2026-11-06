"use client";

import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { TaskPin, ToolPin } from "@ratel/design-system/entity";
import { Section } from "@ratel/design-system/section";
import { Callout } from "@ratel/design-system/states";
import { ArrowRight, CircleCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { NounTitle } from "@/components/console/health/v2/NounTitle";
import { tasksNeedingLook } from "@/components/console/health/v2/summary-model";
import { TaskStatusBadge } from "@/components/console/tasks/TaskMarks";
import { DEFAULT_WORKFLOW_CONFIG } from "@/lib/readings/trace-signals/workflows/types";
import { capabilityCatalogHref } from "@/lib/views/intents/hrefs";
import { formatCount, formatShare, MISSING } from "@/lib/views/tasks/format";
import type { TaskListModel, TaskRow } from "@/lib/views/tasks/model";
import { taskHref, tasksHref } from "@/lib/views/tasks/paths";

/**
 * The tasks that are failing, slow or worth watching, worst status first, as
 * a compact table of pins: the task in its color, its weakest step as a tool
 * pin with how often it fails, its status and numbers. A row opens the
 * task's page; "All tasks" opens the list.
 */

const QUIET = "text-ui text-fg-muted";

export function TasksNeedingLook({
  projectId,
  tasks,
}: {
  projectId: string;
  tasks: TaskListModel | null;
}) {
  const router = useRouter();
  const all = (
    <Link href={tasksHref(projectId)} className={buttonVariants({ variant: "ghost", size: "sm" })}>
      All tasks
      {tasks && tasks.rows.length > 0 ? (
        <span className="text-fg-subtle tabular-nums">{formatCount(tasks.rows.length)}</span>
      ) : null}
      <ArrowRight aria-hidden className="size-3.5" />
    </Link>
  );
  const rows = tasks?.state === "ready" ? tasksNeedingLook(tasks.rows) : [];
  const columns: readonly Column<TaskRow>[] = [
    {
      id: "task",
      header: "Task",
      className: "w-1/2 max-w-0 min-w-40",
      cell: (row) => <TaskCell projectId={projectId} task={row} />,
    },
    {
      id: "weakest",
      header: "Weakest step",
      className: "max-w-0 max-md:hidden",
      headerClassName: "max-md:hidden",
      cell: (row) => <WeakestCell projectId={projectId} task={row} />,
    },
    {
      id: "status",
      header: "Status",
      width: "6.5rem",
      cell: (row) => <TaskStatusBadge status={row.status} />,
    },
    {
      id: "runs",
      header: "Runs",
      align: "right",
      width: "4.5rem",
      className: "max-md:hidden",
      headerClassName: "max-md:hidden",
      cell: (row) => formatCount(row.runs),
    },
    {
      id: "finish",
      header: "Finish rate",
      align: "right",
      width: "6rem",
      cell: (row) => formatShare(row.finishRate),
    },
  ];
  return (
    <Section
      title={<NounTitle noun="task">Tasks that need a look</NounTitle>}
      actions={all}
      className="min-w-0"
    >
      <div data-health-tasks={tasks?.state ?? "unavailable"}>
        {tasks === null ? (
          <Callout tone="danger" title="Couldn't load tasks">
            Try again in a moment. The rest of this page still works.
          </Callout>
        ) : tasks.state === "no_reading" ? (
          <p className={QUIET}>Tasks appear after the next reading of your agent&apos;s runs.</p>
        ) : tasks.state === "no_tasks" ? (
          <p className={QUIET}>
            No task repeats yet. A task shows up once at least {DEFAULT_WORKFLOW_CONFIG.minSupport}{" "}
            runs use the same {DEFAULT_WORKFLOW_CONFIG.minSize} or more tools together.
          </p>
        ) : tasks.state === "blocked" ? (
          <p className={QUIET}>
            Tasks are read from runs with tool calls, one request each. They appear once those
            arrive.
          </p>
        ) : rows.length === 0 ? (
          <p className={cn(QUIET, "flex items-center gap-2")}>
            <CircleCheck aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-success" />
            No task needs a look: none is failing, slow or worth watching.
          </p>
        ) : (
          <DataTable
            caption="Tasks that need a look"
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            onRowOpen={(row) => router.push(taskHref(projectId, row.id))}
          />
        )}
      </div>
    </Section>
  );
}

/** The task as its pin, in its color. */
function TaskCell({ projectId, task }: { projectId: string; task: TaskRow }) {
  return (
    <span className="flex min-w-0 py-1.5" data-task-row={task.id}>
      <TaskPin name={task.name} slot={task.color} href={taskHref(projectId, task.id)} />
    </span>
  );
}

/** Why it is here: the step that fails most, as its tool pin, and how often it fails. */
function WeakestCell({ projectId, task }: { projectId: string; task: TaskRow }) {
  if (!task.weakest) return <span className="text-fg-subtle">{MISSING}</span>;
  return (
    <span className="flex min-w-0 items-center gap-2" data-task-weakest={task.weakest.toolId}>
      <ToolPin
        name={task.weakest.label}
        href={capabilityCatalogHref(projectId, "tool", task.weakest.toolId)}
      />
      <span className="shrink-0 text-xs whitespace-nowrap text-fg-subtle tabular-nums">
        {formatShare(task.weakest.failureShare)} fail
      </span>
    </span>
  );
}
