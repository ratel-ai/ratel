import { Section } from "@ratel/design-system/section";
import { Callout, Skeleton } from "@ratel/design-system/states";
import { Suspense } from "react";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { taskEvalViewFor } from "@/lib/views/task-evals/store";
import { Evals } from "./Evals";

export function TaskEvals({ projectId, taskId }: { projectId: string; taskId: string }) {
  return (
    <Suspense
      fallback={
        <Section title="Evals">
          <Skeleton className="h-52" />
        </Section>
      }
    >
      <EvalsContent projectId={projectId} taskId={taskId} />
    </Suspense>
  );
}

async function EvalsContent({ projectId, taskId }: { projectId: string; taskId: string }) {
  const data = await loadOrFallback({
    operation: "task_evals_read",
    distinctId: `project:${projectId}`,
    fallback: null,
    load: () => taskEvalViewFor(projectId, taskId),
  });
  if (!data)
    return (
      <Section title="Evals">
        <Callout tone="danger" title="Could not load evals">
          Reload this page to try again.
        </Callout>
      </Section>
    );
  return <Evals projectId={projectId} taskId={taskId} {...data} />;
}
