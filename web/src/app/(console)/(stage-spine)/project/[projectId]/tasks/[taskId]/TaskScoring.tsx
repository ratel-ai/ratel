import { Section } from "@ratel/design-system/section";
import { Callout, Skeleton } from "@ratel/design-system/states";
import { Suspense } from "react";
import { TaskLiveScores } from "@/components/console/scorers/TaskLiveScores";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { loadTaskScorers } from "@/lib/views/scorers/task-scores";
import { taskShipmentsFor } from "@/lib/views/task-evals/post-ship";
import { dailyScoresFor, scorersFor } from "@/lib/views/task-scorers/store";
import { SCORER_KINDS } from "@/lib/views/task-scorers/types";
import { ScoreChart } from "./ScoreChart";
import { ScorerForm, Scorers } from "./Scorers";
import { ShipmentResults } from "./ShipmentResults";

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

/** With the `scorers` flag on: the task's live scores are the stored results of its scorers. */
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
        <Section title="Live scores">
          <Skeleton className="h-52" />
        </Section>
      }
    >
      <LiveContent projectId={projectId} taskId={taskId} now={now} />
    </Suspense>
  );
}

/** The scorers the eval gate grades simulations with, and the releases it measured. */
export function SimulationScoring({ projectId, taskId }: { projectId: string; taskId: string }) {
  return (
    <Suspense
      fallback={
        <Section title="Simulation scorers">
          <Skeleton className="h-52" />
        </Section>
      }
    >
      <SimulationContent projectId={projectId} taskId={taskId} />
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
  const scorers = await loadOrFallback({
    operation: "task_live_scorers_read",
    distinctId: `project:${projectId}`,
    fallback: null,
    load: () => loadTaskScorers(projectId, taskId, now),
  });
  if (!scorers)
    return (
      <Section title="Live scores">
        <Callout tone="danger" title="Could not load the live scores">
          Reload this page to try again.
        </Callout>
      </Section>
    );
  return <TaskLiveScores projectId={projectId} taskId={taskId} scorers={scorers} />;
}

async function SimulationContent({ projectId, taskId }: { projectId: string; taskId: string }) {
  const data = await loadOrFallback({
    operation: "task_simulation_scorers_read",
    distinctId: `project:${projectId}`,
    fallback: null,
    load: async () => {
      const [scorers, shipments] = await Promise.all([
        scorersFor(projectId, taskId),
        taskShipmentsFor(projectId, taskId),
      ]);
      return { scorers, shipments };
    },
  });
  if (!data)
    return (
      <Section title="Simulation scorers">
        <Callout tone="danger" title="Could not load scorers">
          Reload this page to try again.
        </Callout>
      </Section>
    );
  return (
    <>
      {data.shipments.length > 0 ? (
        <Section title="Releases">
          <ShipmentResults shipments={data.shipments} projectId={projectId} taskId={taskId} />
        </Section>
      ) : null}
      <Section
        title="Simulation scorers"
        description="Set what counts as a passing run when a fix is simulated."
      >
        <div className="divide-y divide-line border-y border-line">
          {SCORER_KINDS.map((kind) => {
            const scorer = data.scorers.find((item) => item.kind === kind);
            return (
              <ScorerForm
                key={`${kind}:${JSON.stringify(scorer)}`}
                projectId={projectId}
                taskId={taskId}
                kind={kind}
                scorer={scorer}
              />
            );
          })}
        </div>
      </Section>
    </>
  );
}
