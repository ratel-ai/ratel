"use client";

import { cn } from "@ratel/design-system/cn";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { IntentPin, NounIcon, ToolPin } from "@ratel/design-system/entity";
import { Panel, usePeek } from "@ratel/design-system/panel";
import { EmptyState } from "@ratel/design-system/states";
import { CircleX, type LucideIcon, PackageX } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { StepPins } from "@/components/console/tasks/StepPins";
import { TaskDot, TaskStatusBadge, TaskStatusIcon } from "@/components/console/tasks/TaskMarks";
import { formatCount, formatPer100, formatShare, plural } from "@/lib/views/tasks/format";
import type { TaskRow, UnservedRow } from "@/lib/views/tasks/model";
import {
  stepPeek,
  taskHref,
  taskPeekHref,
  topicHref,
  UNSERVED_PEEK,
} from "@/lib/views/tasks/paths";
import { TASK_STATUS_LABEL, WATCH } from "@/lib/views/tasks/status";

type Row = { kind: "task"; task: TaskRow } | { kind: "unserved"; unserved: UnservedRow };

const LINK =
  "rounded-sm text-fg outline-none underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-focus";
const FAINT = "text-fg-faint";

/** The title of the last row and its panel: people's asks that no task runs for. */
export const UNSERVED_TITLE = "Asks no task handles";

/**
 * Every task, busiest first, one row each: its name over its steps (tiny tool
 * pins joined by arrows, so what a task is shows instead of being said), its
 * status, runs and finish rate, the step that fails most as a pin, how often
 * the agent corrects itself, the intents it serves, and its issues and fixes
 * as counts. A row opens the task's page; the last row, the asks no task
 * handles, opens in a Panel (`?peek=unserved`). Names, numbers and ids only
 * in attributes.
 */
export function TasksTable({
  projectId,
  rows,
  unserved,
}: {
  projectId: string;
  rows: readonly TaskRow[];
  unserved: UnservedRow;
}) {
  const router = useRouter();
  const peek = usePeek();
  const open = peek.id === UNSERVED_PEEK;
  // Keep the body while the panel animates out.
  const [shown, setShown] = useState(open);
  if (open && !shown) setShown(true);
  const all: Row[] = [
    ...rows.map((task) => ({ kind: "task" as const, task })),
    { kind: "unserved", unserved },
  ];

  // Narrow screens keep the columns that answer the page's question: the task, its steps and how it finishes.
  const columns: readonly Column<Row>[] = [
    {
      id: "task",
      header: "Task",
      className: "w-full max-w-0 min-w-48",
      cell: (row) =>
        row.kind === "task" ? (
          <TaskCell projectId={projectId} task={row.task} />
        ) : (
          <UnservedCell unserved={row.unserved} />
        ),
    },
    {
      id: "status",
      header: "Status",
      width: "6rem",
      hiddenBelow: "md",
      cell: (row) => (row.kind === "task" ? <TaskStatusBadge status={row.task.status} /> : null),
    },
    {
      id: "runs",
      header: "Runs",
      align: "right",
      width: "4rem",
      hiddenBelow: "lg",
      cell: (row) =>
        row.kind === "task" ? (
          formatCount(row.task.runs)
        ) : row.unserved.measured ? (
          formatCount(row.unserved.runs)
        ) : (
          <span className={FAINT}>–</span>
        ),
    },
    {
      id: "finish",
      header: "Finish rate",
      align: "right",
      width: "5.5rem",
      cell: (row) => (row.kind === "task" ? formatShare(row.task.finishRate) : null),
    },
    {
      id: "weakest",
      header: "Weakest step",
      width: "13rem",
      hiddenBelow: "md",
      cell: (row) =>
        row.kind === "task" ? <WeakestCell projectId={projectId} task={row.task} /> : null,
    },
    {
      id: "corrections",
      header: (
        <span className="inline-flex flex-col items-end leading-4">
          Self-corrections
          <span className="font-normal">per 100 runs</span>
        </span>
      ),
      align: "right",
      width: "6.5rem",
      className: "max-xl:hidden",
      headerClassName: "max-xl:hidden",
      cell: (row) => (row.kind === "task" ? formatPer100(row.task.correctionsPer100) : null),
    },
    {
      id: "intents",
      header: "Intents",
      width: "11rem",
      // Only the widest screens have room for a name next to the steps; the task's page lists them all.
      className: "max-w-44 max-2xl:hidden",
      headerClassName: "max-2xl:hidden",
      cell: (row) =>
        row.kind === "task" ? <IntentsCell projectId={projectId} task={row.task} /> : null,
    },
    {
      id: "issues",
      header: "Issues and fixes",
      width: "6rem",
      className: "max-xl:hidden",
      headerClassName: "max-xl:hidden",
      cell: (row) =>
        row.kind === "task" ? <IssuesCell projectId={projectId} task={row.task} /> : null,
    },
  ];

  return (
    <>
      <DataTable
        caption="Tasks, busiest first"
        columns={columns}
        rows={all}
        rowKey={(row) => (row.kind === "task" ? row.task.id : UNSERVED_PEEK)}
        selectedKey={open ? UNSERVED_PEEK : null}
        onRowOpen={(row) => {
          if (row.kind === "task") router.push(taskHref(projectId, row.task.id));
          else peek.open(UNSERVED_PEEK);
        }}
        empty={<EmptyState title="No tasks" />}
      />
      <Panel
        open={open}
        onOpenChange={(next) => {
          if (!next) peek.close();
        }}
        title={UNSERVED_TITLE}
        subtitle={
          unserved.measured
            ? `${plural(unserved.asks.length, "ask", "asks")}, ${plural(unserved.runs, "run", "runs")}`
            : "Not measured"
        }
      >
        {shown ? <UnservedBody unserved={unserved} /> : null}
      </Panel>
    </>
  );
}

/** The task's color and name over its steps; on a phone, where the status column folds away, its status mark too. */
function TaskCell({ projectId, task }: { projectId: string; task: TaskRow }) {
  const steps = task.steps ?? [];
  return (
    <span className="flex min-w-0 flex-col gap-1 py-2" data-task-row={task.id}>
      <span className="flex min-w-0 items-center gap-2">
        <TaskDot color={task.color} />
        <Link href={taskHref(projectId, task.id)} className={cn(LINK, "truncate font-medium")}>
          {task.name}
        </Link>
        <span className="md:hidden">
          <TaskStatusIcon status={task.status} />
          <span className="sr-only">{TASK_STATUS_LABEL[task.status]}</span>
        </span>
      </span>
      {steps.length > 0 ? (
        <StepPins
          steps={steps.map((step, index) => ({
            key: `${index}:${step.toolId}`,
            label: step.label,
          }))}
          max={2}
          wideMax={3}
          className="pl-4"
        />
      ) : null}
    </span>
  );
}

function UnservedCell({ unserved }: { unserved: UnservedRow }) {
  return (
    <span className="flex min-w-0 flex-col gap-1 py-2" data-task-row="unserved">
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className="inline-block size-2 shrink-0 rounded-[2px] border border-dashed border-fg-subtle"
        />
        <span className="truncate font-medium text-fg">{UNSERVED_TITLE}</span>
      </span>
      <span className="truncate pl-4 text-xs text-fg-subtle tabular-nums">
        {!unserved.measured
          ? "Not measured yet"
          : unserved.asks.length === 0
            ? "None found"
            : plural(unserved.asks.length, "ask", "asks")}
      </span>
    </span>
  );
}

/**
 * The step that fails the largest share of its calls, as a pin that opens it
 * on the task's page, over how often it fails. Past the Watch line it wears
 * the danger color, as it does on the task's drawing.
 */
function WeakestCell({ projectId, task }: { projectId: string; task: TaskRow }) {
  const weakest = task.weakest;
  if (!weakest) return <span className={FAINT}>None failing</span>;
  const failing =
    weakest.calls >= WATCH.stepMinCalls && weakest.failureShare >= WATCH.stepFailureShare;
  return (
    <span
      className="flex min-w-0 flex-col items-start gap-1 py-2"
      data-task-weakest={weakest.toolId}
      data-weakest-failing={failing ? "true" : undefined}
    >
      <ToolPin
        name={weakest.label}
        href={taskPeekHref(projectId, task.id, stepPeek(weakest.toolId))}
        className={cn(failing && "border-danger/40 bg-danger-subtle text-fg [&_svg]:text-danger")}
      />
      <span className="text-xs whitespace-nowrap text-fg-muted tabular-nums">
        fails {formatShare(weakest.failureShare)}
      </span>
    </span>
  );
}

/** The intent it serves most, as a pin, and how many more. */
function IntentsCell({ projectId, task }: { projectId: string; task: TaskRow }) {
  const topics = task.topics;
  if (topics === null) return <span className={cn(FAINT, "whitespace-nowrap")}>Not measured</span>;
  const [top] = topics;
  if (!top) return <span className={FAINT}>–</span>;
  const more = Math.max(task.topicCount ?? topics.length, topics.length) - 1;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <IntentPin name={top.name} href={topicHref(projectId, top.id)} className="min-w-0 shrink" />
      {more > 0 ? (
        <span className="shrink-0 text-xs text-fg-subtle tabular-nums">
          <span aria-hidden>+{more}</span>
          <span className="sr-only">and {plural(more, "more intent", "more intents")}</span>
        </span>
      ) : null}
    </span>
  );
}

/** Its open issues and fixes as two counts, each with its noun's mark: issues open the task's list of them, fixes the Fixes list for it. */
function IssuesCell({ projectId, task }: { projectId: string; task: TaskRow }) {
  if (task.issues === 0 && task.fixes === 0) return <span className={FAINT}>None</span>;
  const COUNT =
    "inline-flex items-center gap-1 rounded-sm text-ui text-fg tabular-nums outline-none hover:underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-focus";
  return (
    <span className="flex items-center gap-3">
      {task.issues > 0 ? (
        <Link
          href={`${taskHref(projectId, task.id)}#issues`}
          className={COUNT}
          data-task-issues={task.issues}
        >
          <NounIcon noun="issue" />
          {formatCount(task.issues)}
          <span className="sr-only">{task.issues === 1 ? " issue" : " issues"}</span>
        </Link>
      ) : null}
      {task.fixes > 0 ? (
        <Link href={task.fixesHref} className={COUNT} data-task-fixes={task.fixes}>
          <NounIcon noun="fix" />
          {formatCount(task.fixes)}
          <span className="sr-only">{task.fixes === 1 ? " fix" : " fixes"}</span>
        </Link>
      ) : null}
    </span>
  );
}

const REASON: Readonly<Record<"no_tool" | "unresolved", { icon: LucideIcon; text: string }>> = {
  no_tool: { icon: PackageX, text: "No tool does this" },
  unresolved: { icon: CircleX, text: "Failed or called no tool" },
};

/** The panel: each ask no task handles, how many runs asked it and why it counts. Text shown, never in attributes. */
function UnservedBody({ unserved }: { unserved: UnservedRow }) {
  if (!unserved.measured) {
    return (
      <p className="text-ui text-fg-muted">
        Read from what people ask, once a reading has placed their asks in tasks.
      </p>
    );
  }
  if (unserved.asks.length === 0)
    return (
      <p className="text-ui text-fg-muted">Every ask in this window went to a task or a tool.</p>
    );
  return (
    <ul className="flex flex-col">
      {unserved.asks.map((ask, index) => {
        const reason = ask.reason ? REASON[ask.reason] : null;
        return (
          <li
            key={index}
            className="flex flex-col gap-1.5 border-b border-line py-3 first:pt-0 last:border-b-0"
          >
            <p className="text-sm text-fg">{ask.title}</p>
            {ask.others.length > 0 ? (
              <ul className="flex flex-col gap-0.5 border-l border-line pl-3">
                {ask.others.map((other, i) => (
                  <li key={i} className="text-xs text-fg-muted">
                    {other}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle tabular-nums">
              <span>{plural(ask.runs, "run", "runs")}</span>
              {reason ? (
                <span className="inline-flex items-center gap-1">
                  <reason.icon aria-hidden strokeWidth={1.5} className="size-3.5 shrink-0" />
                  {reason.text}
                </span>
              ) : null}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
