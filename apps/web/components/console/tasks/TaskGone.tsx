import { buttonVariants } from "@ratel/design-system/button-variants";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { EmptyState } from "@ratel/design-system/states";
import Link from "next/link";
import { agentHealthHref, tasksHref } from "@/lib/views/tasks/paths";

/**
 * A task link the latest reading cannot answer: the task's tools changed
 * enough to make it another task, or its runs stopped. Said in place, with
 * the way back, rather than a 404 (DESIGN.md, Hidden, never broken).
 */
export function TaskGone({
  projectId,
  known,
  reading,
}: {
  projectId: string;
  known: boolean;
  reading: boolean;
}) {
  return (
    <Page>
      <PageHeader
        title="Task"
        crumbs={[
          { label: "Agent health", href: agentHealthHref(projectId) },
          { label: "Tasks", href: tasksHref(projectId) },
        ]}
      />
      <PageBody>
        <section
          aria-label="Task not found"
          className="rounded-lg border border-line dot-grid-fade"
          data-task-gone=""
        >
          <EmptyState
            emblem
            title={reading ? "This task is not in the latest reading" : "No reading yet"}
            description={
              reading
                ? known
                  ? "Its tools changed enough to make it another task, or its runs stopped in this window. The list has the tasks the agent runs now."
                  : "No task was found in this window."
                : "Tasks appear after Agent health reads your agent's runs."
            }
            action={
              <Link
                href={tasksHref(projectId)}
                className={buttonVariants({ variant: "secondary" })}
              >
                Open Tasks
              </Link>
            }
          />
        </section>
      </PageBody>
    </Page>
  );
}
