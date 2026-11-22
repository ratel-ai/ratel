"use client";

import { buttonVariants } from "@ratel/design-system/button-variants";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Section } from "@ratel/design-system/section";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { FlaskConical } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { TaskEvalRow, TaskEvalsModel } from "@/lib/views/evals/page";
import { evalHref, evalRunHref, evalsHref } from "@/lib/views/evals/paths";
import { EvalNameCell } from "./EvalNameCell";
import { CHANGE_TONE, CHANGE_WORDS, ResultStatus } from "./marks";
import { RunAllButton } from "./RunAllButton";

/**
 * RC-317: a task page's Evals section, shown with `cloud-eval-gate` on. Each
 * eval of the task with its checks, last result and change; a row opens the
 * eval. "Run this task's evals" queues a manual run of them.
 */
export function TaskEvalsSection({
  projectId,
  taskId,
  rows,
  live,
}: TaskEvalsModel & { projectId: string; taskId: string }) {
  const router = useRouter();
  const columns: Column<TaskEvalRow>[] = [
    { id: "eval", header: "Eval", cell: (row) => <EvalNameCell row={row} /> },
    {
      id: "checks",
      header: "Scorers",
      width: "7rem",
      hiddenBelow: "sm",
      cell: (row) => `${row.checks} built-in`,
    },
    {
      id: "last",
      header: "Last run",
      width: "8rem",
      cell: (row) => <ResultStatus mark={row.last} />,
    },
    {
      id: "change",
      header: "Change",
      width: "7rem",
      align: "right",
      cell: (row) =>
        row.change ? (
          <span className={CHANGE_TONE[row.change]}>{CHANGE_WORDS[row.change]}</span>
        ) : null,
    },
  ];
  return (
    <Section
      title="Evals"
      description="The evals of the suite that test this task."
      actions={
        <>
          <Link
            href={evalsHref(projectId, { task: taskId })}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            See all on Evals
          </Link>
          <RunAllButton
            projectId={projectId}
            task={taskId}
            disabled={rows.length === 0 || live !== null}
          />
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {rows.length > 0 ? <p className="text-ui text-fg-muted">{countLine(rows)}</p> : null}
        {live ? (
          <Callout
            title={live.status === "queued" ? "Run queued" : "Running"}
            action={
              <Link
                href={evalRunHref(projectId, live.id)}
                className={buttonVariants({ variant: "ghost", size: "sm" })}
              >
                Open the run
              </Link>
            }
          >
            {`${live.evalCount} ${live.evalCount === 1 ? "eval runs" : "evals run"} against the agent as recorded. Results show here when it finishes.`}
          </Callout>
        ) : null}
        <DataTable
          caption="Evals of this task"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          onRowOpen={(row) => router.push(evalHref(projectId, row.id))}
          empty={
            <EmptyState
              icon={FlaskConical}
              title="No evals test this task yet"
              description="Pin a run of this task, or link an eval to it on Evals."
            />
          }
        />
      </div>
    </Section>
  );
}

/** "6 evals · 4 suggested from this task", or "6 evals" when none is a suggestion. */
function countLine(rows: readonly TaskEvalRow[]): string {
  const suggested = rows.filter((row) => row.suggested).length;
  const total = `${rows.length} ${rows.length === 1 ? "eval" : "evals"}`;
  return suggested > 0 ? `${total} · ${suggested} suggested from this task` : total;
}
