import { Section } from "@ratel/design-system/section";
import { Callout, Skeleton } from "@ratel/design-system/states";
import { Suspense } from "react";
import { ScorerPickerProvider } from "@/components/console/scorers/ScorerPickerProvider";
import { TaskLiveScores } from "@/components/console/scorers/TaskLiveScores";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { loadScorerPicker } from "@/lib/views/scorers/picker";
import { loadTaskScorers } from "@/lib/views/scorers/task-scores";

/** The global scorers attached to the task, and their stored results. */
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
      const [scorers, picker] = await Promise.all([
        loadTaskScorers(projectId, taskId, now),
        loadScorerPicker(projectId, now),
      ]);
      return { scorers, picker };
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
  return (
    <ScorerPickerProvider projectId={projectId} data={data.picker}>
      <TaskLiveScores projectId={projectId} taskId={taskId} scorers={data.scorers} />
    </ScorerPickerProvider>
  );
}
