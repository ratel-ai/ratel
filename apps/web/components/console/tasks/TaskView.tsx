import { Disclosure } from "@ratel/design-system/disclosure";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { type StatProps, StatRow } from "@ratel/design-system/stat-row";
import { TASK_COLOR_CLASSES } from "@ratel/design-system/task-colors";
import type { ReactNode } from "react";
import { TaskFlowDiagram } from "@/components/console/tasks/TaskFlowDiagram";
import {
  TaskColorBar,
  TaskStatusBadge,
  TaskStatusIcon,
} from "@/components/console/tasks/TaskMarks";
import { TaskPanels } from "@/components/console/tasks/TaskPanels";
import {
  CorrectionsStrip,
  ExampleRuns,
  FixesList,
  IntentsList,
  IssuesList,
  NounTitle,
} from "@/components/console/tasks/TaskSections";
import { TaskPipeline } from "@/components/console/tasks/TaskSteps";
import { compactNumber } from "@/lib/views/intents/map/map-model";
import { buildIntentFlow } from "@/lib/views/tasks/flow-layout";
import { formatMoney, formatMs, formatPer100, formatShare, plural } from "@/lib/views/tasks/format";
import type { CostView, TaskDetailModel } from "@/lib/views/tasks/model";
import { selfCorrectionsHref, tasksHref } from "@/lib/views/tasks/paths";
import type { ExampleRun } from "@/lib/views/tasks/queries";

/** Arrows the drawing shows: any hop taken in at least this share of a step's visits. */
const FLOW_MIN_P = 0.1;

/**
 * One task: what the agent does for this ask and how well. A header in the
 * task's color with its status, its numbers in one row, then the story in
 * order: its steps as a drawing, how often the agent corrects itself, its
 * issues, the fixes for it, the intents it serves and example runs to open.
 * The faces carry marks and numbers; sentences wait in the panel a step or an
 * issue opens.
 */
export function TaskView({
  projectId,
  task,
  examples,
  now = new Date(),
}: {
  projectId: string;
  task: TaskDetailModel;
  examples: ReadonlyMap<string, ExampleRun>;
  now?: Date;
}) {
  const names = Object.fromEntries(
    [...task.steps, ...task.sideSteps].map((step) => [step.toolId, step.label]),
  );
  const flow = buildIntentFlow(
    { edges: task.flow.edges, tools: task.flow.tools, names },
    { minP: FLOW_MIN_P },
  );
  // The drawing earns its place only when runs leave the straight line of steps.
  const branches =
    flow.nodes.length > task.steps.length ||
    flow.arrows.length > Math.max(0, task.steps.length - 1);
  return (
    <Page>
      <PageHeader
        // One crumb: on a phone the task's name keeps the room (the rail says Agent health).
        crumbs={[{ label: "Tasks", href: tasksHref(projectId) }]}
        title={
          <span className="inline-flex min-w-0 items-center gap-2.5">
            <TaskColorBar color={task.color} />
            <span className="truncate">{task.name}</span>
          </span>
        }
        description={task.description ?? undefined}
        actions={<TaskStatusBadge status={task.status} className="text-sm" />}
      />
      <PageBody>
        <StatRow stats={stats(projectId, task)} />
        <Section title={<NounTitle noun="task">Steps</NounTitle>} actions={orderNote(task)}>
          <TaskPipeline
            steps={task.steps}
            sideSteps={task.sideSteps}
            hasReading={task.hasReading}
            color={task.color}
          />
          {branches ? (
            <Disclosure
              title="How runs move between steps"
              hint={plural(flow.arrows.length, "hop", "hops")}
            >
              <TaskFlowDiagram
                runs={task.runs}
                layout={flow}
                barClass={TASK_COLOR_CLASSES[task.color ?? "neutral"].fill}
              />
            </Disclosure>
          ) : null}
        </Section>
        <CorrectionsStrip projectId={projectId} taskId={task.id} corrections={task.corrections} />
        <IssuesList issues={task.issues} />
        <div className="grid gap-8 lg:grid-cols-2">
          <FixesList fixes={task.fixes} allHref={task.allFixesHref} />
          <IntentsList projectId={projectId} topics={task.topics} runs={task.runs} />
        </div>
        <ExampleRuns
          projectId={projectId}
          taskId={task.id}
          examples={task.examples}
          runs={examples}
          focusTools={task.focusTools}
          now={now}
        />
        <TaskPanels
          projectId={projectId}
          taskId={task.id}
          taskName={task.name}
          color={task.color}
          steps={task.steps}
          sideSteps={task.sideSteps}
          issues={task.issues}
          hasReading={task.hasReading}
        />
      </PageBody>
    </Page>
  );
}

/** How fixed the order is, as a quiet note beside the steps' title. */
function orderNote(task: TaskDetailModel): ReactNode {
  if (!task.hasReading || task.steps.length < 2) return null;
  return (
    <span className="text-xs text-fg-subtle tabular-nums">
      Same order in {formatShare(task.order.stability)} of runs
    </span>
  );
}

/** A stat's value with the status mark when the status comes from it, so the eye finds why the task is not healthy. */
function marked(value: string, task: TaskDetailModel, reason: boolean): ReactNode {
  if (!reason) return value;
  return (
    <span className="inline-flex items-center gap-2" data-status-reason="">
      {value}
      <TaskStatusIcon status={task.status} className="size-4" />
    </span>
  );
}

function costStat(cost: CostView): StatProps | null {
  if (cost.kind === "measured") {
    return {
      label: "Cost per run",
      value: cost.perRun === null ? "Not priced" : formatMoney(cost.perRun),
      hint: `${plural(cost.runs, "priced run", "priced runs")}`,
    };
  }
  if (cost.kind === "estimated")
    return {
      label: "Cost per run",
      value: `~${formatMoney(cost.perRun)}`,
      hint: "Estimated from its tool calls",
    };
  return null;
}

function stats(projectId: string, task: TaskDetailModel): StatProps[] {
  const finishOf = task.runs + task.askedNoTool;
  const finishReason =
    task.status === "failing" || (task.status === "watch" && task.watch === "finish");
  const cost = costStat(task.cost);
  return [
    {
      label: "Runs",
      value: compactNumber(task.runs),
      hint:
        task.share === null
          ? `Last ${task.windowDays} days`
          : `${formatShare(task.share)} of all runs, ${task.windowDays} days`,
    },
    {
      label: "Finish rate",
      value: marked(formatShare(task.finishRate), task, finishReason),
      hint: `${compactNumber(task.finishedRuns)} of ${compactNumber(finishOf)}`,
    },
    {
      label: "Typical run",
      value: marked(formatMs(task.medianMs), task, task.status === "slow"),
      hint: task.callsPerRun === null ? undefined : `${task.callsPerRun.toFixed(1)} calls`,
    },
    {
      label: "Self-corrections per 100 runs",
      value: marked(
        formatPer100(task.correctionsPer100),
        task,
        task.status === "watch" && task.watch === "corrections",
      ),
      href: selfCorrectionsHref(projectId, { task: task.id }),
    },
    ...(cost ? [cost] : []),
  ];
}
