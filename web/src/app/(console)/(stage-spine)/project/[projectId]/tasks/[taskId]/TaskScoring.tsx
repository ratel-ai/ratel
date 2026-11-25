import { Section } from "@ratel/design-system/section";
import { Callout, Skeleton } from "@ratel/design-system/states";
import { Suspense } from "react";
import { TaskLiveScores } from "@/components/console/scorers/TaskLiveScores";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { loadAttachableScorers, loadTaskScorers } from "@/lib/views/scorers/task-scores";
import { taskShipmentsFor } from "@/lib/views/task-evals/post-ship";
import { dailyScoresFor, scorersFor } from "@/lib/views/task-scorers/store";
import { ScoreChart } from "./ScoreChart";
import { Scorers } from "./Scorers";

export function TaskScoring({
  projectId,
  taskId,
  today,
}: {
  projectId: string;
  taskId: string;
  today: string;
}) {
  return (
    <Suspense
      fallback={
        <Section title="Score">
          <Skeleton className="h-52" />
        </Section>
      }
    >
      <ScoringContent projectId={projectId} taskId={taskId} today={today} />
    </Suspense>
  );
}

async function ScoringContent({
  projectId,
  taskId,
  today,
}: {
  projectId: string;
  taskId: string;
  today: string;
}) {
  const data = await loadOrFallback({
    operation: "task_scorers_read",
    distinctId: `project:${projectId}`,
    fallback: null,
    load: async () => {
      const [scorers, scores, shipments] = await Promise.all([
        scorersFor(projectId, taskId),
        dailyScoresFor(projectId, taskId),
        taskShipmentsFor(projectId, taskId),
      ]);
      return { scorers, scores, shipments };
    },
  });
  if (!data)
    return (
      <Section title="Score and scorers">
        <Callout tone="danger" title="Could not load scorers">
          Reload this page to try again.
        </Callout>
      </Section>
    );
  return (
    <>
      <ScoreChart
        rows={data.scores}
        today={today}
        shipments={data.shipments}
        projectId={projectId}
        taskId={taskId}
      />
      <Scorers projectId={projectId} taskId={taskId} scorers={data.scorers} />
    </>
  );
}

/** With the `customMonitoring` flag on: the global scorers attached to the task, and their stored results. */
export function TaskLiveScoring({
  projectId,
  taskId,
  now,
}: {
  projectId: string;
  taskId: string;
  now: Date;
}) {
  return (
    <Suspense
      fallback={
        <Section title="Scorers">
          <Skeleton className="h-52" />
        </Section>
      }
    >
      <LiveContent projectId={projectId} taskId={taskId} now={now} />
    </Suspense>
  );
}

async function LiveContent({
  projectId,
  taskId,
  now,
}: {
  projectId: string;
  taskId: string;
  now: Date;
}) {
  const data = await loadOrFallback({
    operation: "task_live_scorers_read",
    distinctId: `project:${projectId}`,
    fallback: null,
    load: async () => {
      const [scorers, attachable] = await Promise.all([
        loadTaskScorers(projectId, taskId, now),
        loadAttachableScorers(projectId, taskId),
      ]);
      return { scorers, attachable };
    },
  });
  if (!data)
    return (
      <Section title="Scorers">
        <Callout tone="danger" title="Could not load scorers">
          Reload this page to try again.
        </Callout>
      </Section>
    );
  return <TaskLiveScores projectId={projectId} taskId={taskId} {...data} />;
}
