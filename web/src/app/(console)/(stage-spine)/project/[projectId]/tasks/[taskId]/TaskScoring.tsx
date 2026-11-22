import { Section } from "@ratel/design-system/section";
import { Callout, Skeleton } from "@ratel/design-system/states";
import { Suspense } from "react";
import { loadOrFallback } from "@/lib/platform/resilient-read";
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
