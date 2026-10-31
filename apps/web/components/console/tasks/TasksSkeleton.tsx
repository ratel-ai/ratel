import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Skeleton } from "@ratel/design-system/states";
import { TASKS_TITLE } from "@/components/console/tasks/TasksView";

/**
 * The task pages while they load: the same header, the numbers and the rows
 * (a name over its step pins) or the pipeline they will hold, so nothing moves
 * when the data lands (DESIGN.md, Loading).
 */

function Stats({ count }: { count: number }) {
  return (
    <div
      aria-hidden
      className={`grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line ${count === 5 ? "lg:grid-cols-5" : "lg:grid-cols-4"}`}
    >
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex flex-col gap-2 bg-app p-4">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-6 w-14" />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

export function TasksSkeleton() {
  return (
    <Page>
      <span role="status" className="sr-only">
        Loading tasks…
      </span>
      <PageHeader title={TASKS_TITLE} />
      <PageBody wide>
        <Stats count={4} />
        <div aria-hidden data-tasks-skeleton="">
          <div className="flex h-9 items-center gap-6 border-b border-line px-3">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="ml-auto h-3 w-12" />
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3 w-20" />
          </div>
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="flex h-16 items-center gap-6 border-b border-line px-3">
              <div className="flex w-1/3 flex-col gap-2">
                <Skeleton className="h-3 w-2/3" />
                <div className="flex items-center gap-2 pl-4">
                  <Skeleton className="h-5 w-24" />
                  <Skeleton className="h-5 w-28" />
                </div>
              </div>
              <Skeleton className="ml-auto h-3 w-14" />
              <Skeleton className="h-3 w-10" />
              <Skeleton className="h-3 w-24" />
            </div>
          ))}
        </div>
      </PageBody>
    </Page>
  );
}

export function TaskSkeleton() {
  return (
    <Page>
      <span role="status" className="sr-only">
        Loading the task…
      </span>
      <PageHeader
        title={
          <>
            <span className="sr-only">Task</span>
            <span
              aria-hidden
              className="inline-block h-5 w-48 animate-pulse rounded-md bg-hover align-middle motion-reduce:animate-none"
            />
          </>
        }
      />
      <PageBody>
        <Stats count={4} />
        <div aria-hidden className="flex flex-col gap-8" data-task-skeleton="">
          <div className="flex flex-col gap-3">
            <Skeleton className="h-4 w-20" />
            <div className="flex flex-col gap-6 md:flex-row md:gap-14">
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="flex flex-col gap-2">
                  <Skeleton className="h-8 w-44" />
                  <Skeleton className="h-3 w-32" />
                  <Skeleton className="h-3 w-24" />
                </div>
              ))}
            </div>
          </div>
          <Skeleton className="h-12 w-full rounded-lg" />
          <div className="flex flex-col gap-3">
            <Skeleton className="h-4 w-20" />
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-11 w-full" />
            ))}
          </div>
        </div>
      </PageBody>
    </Page>
  );
}

/** A session while it loads: the header and a few turns of steps. */
export function SessionSkeleton() {
  return (
    <Page>
      <span role="status" className="sr-only">
        Loading the session…
      </span>
      <PageHeader
        title="Session"
        description="Every closed turn of this session, its searches and tool calls in order."
      />
      <PageBody>
        <div aria-hidden className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-64" />
        </div>
        <div aria-hidden className="flex flex-col">
          {Array.from({ length: 5 }, (_, index) => (
            <div
              key={index}
              className="grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-4 border-b border-line py-3"
            >
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-3 w-16" />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {Array.from({ length: 3 + (index % 3) }, (_, step) => (
                  <Skeleton key={step} className="h-6 w-24" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </PageBody>
    </Page>
  );
}
