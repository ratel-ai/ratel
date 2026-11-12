"use client";

import { Button } from "@ratel/design-system/button";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Dialog } from "@ratel/design-system/dialog";
import { Disclosure } from "@ratel/design-system/disclosure";
import { Section } from "@ratel/design-system/section";
import { Callout, EmptyState } from "@ratel/design-system/states";
import Link from "next/link";
import { useState } from "react";
import { ReplayPathsSection } from "@/components/console/eval-gate/ReplayPaths";
import { describeExpected } from "@/lib/views/eval-gate/defaults";
import type { TaskSimulationDetail } from "@/lib/views/task-evals/simulation-page";
import { ShipmentResults } from "../ShipmentResults";
import { DraftEditor } from "./DraftEditor";
import { MarkLive } from "./MarkLive";
import { ScorerResults } from "./ScorerResults";
import { SimulationPoller, SimulationStatus } from "./SimulationControls";
import { TestEditor } from "./TestEditor";

type FixTest = TaskSimulationDetail["fixCases"][number];
type TaskCase = TaskSimulationDetail["taskCases"][number];

export function SimulationDetail({ model }: { model: TaskSimulationDetail }) {
  const [editing, setEditing] = useState<FixTest | "new" | null>(null);
  const latest = model.runs[0] ?? null;
  const scope = { projectId: model.projectId, taskId: model.taskId, fixId: model.fixId };
  const taskColumns: Column<TaskCase>[] = [
    {
      id: "ask",
      header: "Ask",
      cell: (row) => (
        <Link href={row.runHref} className="text-fg hover:underline">
          {row.ask}
        </Link>
      ),
    },
    {
      id: "reason",
      header: "Why this run",
      cell: (row) => <span className="text-fg-subtle">{row.selectionReason}</span>,
    },
  ];
  const fixColumns: Column<FixTest>[] = [
    {
      id: "ask",
      header: "Ask",
      cell: (row) => (
        <Link href={row.runHref} className="text-fg hover:underline">
          {row.ask}
        </Link>
      ),
    },
    {
      id: "expected",
      header: "Expected outcome",
      cell: (row) => (
        <div className="flex flex-col gap-1 py-2">
          <span>
            {describeExpected(
              row.expected,
              new Map(model.tools.map((tool) => [tool.id, tool.label])),
            )}
          </span>
          {row.criteria ? <span className="text-xs text-fg-subtle">{row.criteria}</span> : null}
        </div>
      ),
    },
    {
      id: "edit",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (row) => (
        <Button size="sm" variant="ghost" onClick={() => setEditing(row)}>
          Edit test
        </Button>
      ),
    },
  ];
  return (
    <>
      <SimulationPoller
        active={model.state.state === "running" || model.draftStatus === "drafting"}
      />
      <Section title="Live releases" actions={<MarkLive scope={scope} />}>
        {model.shipments.length ? (
          <ShipmentResults
            shipments={model.shipments}
            projectId={model.projectId}
            taskId={model.taskId}
          />
        ) : (
          <p className="text-ui text-fg-muted">
            Mark this fix as live after you release it to compare its measured effect with the
            prediction.
          </p>
        )}
      </Section>
      <Section title="Draft" actions={<SimulationStatus {...model.state} />}>
        {model.state.stale ? (
          <Callout tone="warning" title="This result is stale">
            The draft, tests, or scorers changed. Run the simulation again to compare the current
            version.
          </Callout>
        ) : null}
        {latest?.error ? (
          <Callout tone="danger" title="The last simulation failed">
            {latest.error}
          </Callout>
        ) : null}
        <DraftEditor
          key={JSON.stringify(model.change)}
          scope={scope}
          change={model.change}
          tools={model.tools}
          running={model.state.state === "running" || model.draftStatus === "drafting"}
        />
      </Section>
      <Section
        title="Task set"
        description={`${model.taskCases.length} past ${model.taskCases.length === 1 ? "run" : "runs"} shared by every fix for this task.`}
        actions={
          <Link
            href={`/project/${encodeURIComponent(model.projectId)}/tasks/${encodeURIComponent(model.taskId)}#evals`}
            className="text-ui text-fg-muted hover:underline"
          >
            Edit task evals
          </Link>
        }
      >
        <ScorerResults breakdown={latest?.breakdown ?? null} group="task" />
        <Disclosure title="Runs in the task set" hint={`${model.taskCases.length} runs`}>
          <DataTable
            caption="Shared task runs"
            columns={taskColumns}
            rows={model.taskCases}
            rowKey={(row) => row.id}
            empty={
              <EmptyState
                title="No task runs yet"
                description="The first simulation selects runs from this task's traces."
              />
            }
          />
        </Disclosure>
      </Section>
      {model.replayRuns.length > 0 ? (
        <ReplayPathsSection
          rows={model.replayRuns}
          names={new Map(model.tools.map((tool) => [tool.id, tool.label]))}
        />
      ) : null}
      <Section
        title="Fix-specific tests"
        description="These tests run only for this fix on this task."
        actions={<Button onClick={() => setEditing("new")}>Add a test</Button>}
      >
        {model.fixCases.length > 0 ? (
          <ScorerResults breakdown={latest?.breakdown ?? null} group="fix" />
        ) : null}
        <DataTable
          caption="Fix-specific tests"
          columns={fixColumns}
          rows={model.fixCases}
          rowKey={(row) => row.id}
          empty={
            <EmptyState
              title="No fix-specific tests"
              description="Add a real trace and describe the outcome you expect."
            />
          }
        />
      </Section>
      <Section
        title="Run history"
        description="Each run preserves its scorer results and compares them with the current draft and tests."
      >
        {model.runs.length === 0 ? (
          <EmptyState
            title="No simulations yet"
            description="Run this draft to compare the before and after results."
          />
        ) : (
          model.runs.map((run) => (
            <Disclosure
              key={run.id}
              title={
                <span className="inline-flex flex-wrap items-center gap-3">
                  <time dateTime={run.createdAt}>
                    {new Date(run.createdAt).toLocaleString("en-GB", {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: "UTC",
                    })}{" "}
                    UTC
                  </time>
                  <SimulationStatus state={run.state} stale={run.stale} />
                </span>
              }
              hint={`${run.caseCount} task ${run.caseCount === 1 ? "run" : "runs"} · ${run.fixCaseCount} fix ${run.fixCaseCount === 1 ? "test" : "tests"}`}
            >
              {run.error ? <p className="mb-3 text-ui text-danger">{run.error}</p> : null}
              <div className="flex flex-col gap-4">
                <p className="text-xs text-fg-subtle">Task set</p>
                <ScorerResults breakdown={run.breakdown} group="task" />
                {run.fixCaseCount > 0 ? (
                  <>
                    <p className="text-xs text-fg-subtle">Fix-specific tests</p>
                    <ScorerResults breakdown={run.breakdown} group="fix" />
                  </>
                ) : null}
              </div>
            </Disclosure>
          ))
        )}
      </Section>
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {editing !== null ? (
          <TestEditor
            key={editing === "new" ? "new" : editing.id}
            scope={scope}
            row={editing === "new" ? undefined : editing}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </Dialog>
    </>
  );
}
