import { buttonVariants } from "@ratel/design-system/button-variants";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { StatRow } from "@ratel/design-system/stat-row";
import { Callout, EmptyState } from "@ratel/design-system/states";
import Link from "next/link";
import { AnalysisStatus } from "@/components/console/freshness/AnalysisStatus";
import { readingSinceText } from "@/components/console/health/section-preview-model";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { TasksTable } from "@/components/console/tasks/TasksTable";
import { DEFAULT_WORKFLOW_CONFIG } from "@/lib/readings/trace-signals/workflows/types";
import { analysisPending, type SectionProgress } from "@/lib/views/freshness/model";
import { absoluteTime, timeAgo } from "@/lib/views/intents/map/labels";
import { compactNumber } from "@/lib/views/intents/map/map-model";
import { formatPer100, formatShare } from "@/lib/views/tasks/format";
import type { TaskListModel } from "@/lib/views/tasks/model";
import { agentHealthHref, selfCorrectionsHref } from "@/lib/views/tasks/paths";

export const TASKS_TITLE = "Tasks";

export function tasksCrumbs(projectId: string) {
  return [{ label: "Agent health", href: agentHealthHref(projectId) }];
}

const FRAME = "rounded-lg border border-line dot-grid-backdrop";

/**
 * Agent health › Tasks: what does my agent do for an ask, and how well? Four
 * numbers, then every task: its name over its steps as tool pins joined by
 * arrows (what a task is, shown rather than said), its status, finish rate,
 * weakest step, self-corrections, intents and its issues and fixes; the last
 * row lists the asks no task handles. Before there is a reading, one
 * designed state sits where the table would.
 */
export function TasksView({
  projectId,
  model,
  now,
  progress = null,
}: {
  projectId: string;
  model: TaskListModel;
  now: Date;
  /** Where the jobs behind tasks stand; null reads as idle. */
  progress?: SectionProgress | null;
}) {
  return (
    <Page>
      <PageHeader
        title={TASKS_TITLE}
        crumbs={tasksCrumbs(projectId)}
        actions={<AnalysisStatus projectId={projectId} section="tasks" initial={progress} />}
      />
      <PageBody wide className={model.state === "ready" ? undefined : "flex-1"}>
        {model.state === "ready" ? (
          <>
            <TasksStats projectId={projectId} model={model} now={now} />
            {model.readingSince ? (
              <Callout>{readingSinceText(model.readingSince, model.excludedRuns)}</Callout>
            ) : null}
            <TasksTable projectId={projectId} rows={model.rows} unserved={model.unserved} />
          </>
        ) : (
          <TasksState projectId={projectId} model={model} working={analysisPending(progress)} />
        )}
      </PageBody>
    </Page>
  );
}

function TasksStats({
  projectId,
  model,
  now,
}: {
  projectId: string;
  model: TaskListModel;
  now: Date;
}) {
  const { stats } = model;
  return (
    <StatRow
      stats={[
        {
          label: "Tasks",
          value: compactNumber(stats.tasks),
          hint: (
            <>
              {model.windowDays ? `Last ${model.windowDays} days` : null}
              {model.readAt ? (
                <>
                  , read{" "}
                  <time dateTime={model.readAt.toISOString()} title={absoluteTime(model.readAt)}>
                    {timeAgo(model.readAt, now)}
                  </time>
                </>
              ) : null}
            </>
          ),
        },
        {
          label: "Runs in a task",
          value: compactNumber(stats.runsInTasks),
          hint:
            stats.allRuns > 0
              ? `${formatShare(Math.min(1, stats.runsInTasks / stats.allRuns))} of ${compactNumber(stats.allRuns)} runs`
              : undefined,
        },
        {
          label: "Finish rate",
          value: formatShare(stats.finishRate),
          hint: "Ended without a failed call",
        },
        {
          label: "Self-corrections per 100 runs",
          value: formatPer100(stats.correctionsPer100),
          href: selfCorrectionsHref(projectId),
        },
      ]}
    />
  );
}

function TasksState({
  projectId,
  model,
  working,
}: {
  projectId: string;
  model: TaskListModel;
  working: boolean;
}) {
  const health = (
    <Link href={agentHealthHref(projectId)} className={buttonVariants({ variant: "secondary" })}>
      Open Agent health
    </Link>
  );
  // A blocked list waits on the agent's own data, not on our work.
  const reading = working && model.state !== "blocked";
  const [title, description] = reading
    ? [
        "Working out your tasks",
        "Agent health is reading your latest runs. Tasks fill in here when it finishes, and this page updates on its own.",
      ]
    : model.state === "blocked" && model.blocked === "mixed_runs"
      ? [
          "Runs mix several asks",
          "Your agent's calls arrive without a turn id, so one run holds several people's asks. Send a turn id with each ask and tasks appear after the next reading.",
        ]
      : model.state === "blocked"
        ? ["No tool calls yet", "Tasks appear once your agent's runs call tools."]
        : model.state === "no_tasks"
          ? [
              "No task repeats yet",
              `A task shows up once at least ${DEFAULT_WORKFLOW_CONFIG.minSupport} runs use the same ${DEFAULT_WORKFLOW_CONFIG.minSize} or more tools together.`,
            ]
          : ["No tasks yet", "Tasks appear after Agent health reads your agent's runs."];
  return (
    <section
      aria-label={title}
      className={`${FRAME} flex flex-1 flex-col justify-center`}
      data-tasks-state={model.state}
    >
      <EmptyState
        emblem
        working={reading}
        title={title}
        description={description}
        action={reading ? undefined : health}
      />
    </section>
  );
}

export function TasksNoDatabase() {
  return (
    <DatabaseUnavailable title={TASKS_TITLE}>
      Tasks become available once setup finishes.
    </DatabaseUnavailable>
  );
}
