import { Badge } from "@ratel/design-system/badge";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { TaskPin } from "@ratel/design-system/entity";
import { Section } from "@ratel/design-system/section";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { formatDuration, formatTimestamp } from "@/lib/synthesis/traces/format";
import type { TaskRef } from "@/lib/views/home/glance";
import type { OverviewData } from "@/lib/views/home/load";
import { relativeTimeLabel } from "@/lib/views/intents/adaptive-view";
import { isSdkOnly } from "./overview-stats";

const DOCS_URL = "https://docs.ratel.sh";

const QUIET_LINK =
  "text-ui text-fg-muted underline decoration-line-strong underline-offset-4 hover:text-fg";

/**
 * The latest runs, small and to the side (the Overview's last word, never its
 * middle): a few rows, each the task the run did (its name when no task holds
 * it), its time and whether it failed. Everything else is on Traces.
 */
export function RecentRunsSection({ data, now }: { data: OverviewData; now: Date }) {
  const tracesHref = `${data.root}/traces?range=${data.rangeParam}`;
  const runs = data.recentRuns;
  return (
    <Section
      title="Recent runs"
      actions={
        runs && runs.length > 0 ? (
          <Link
            href={tracesHref}
            className="inline-flex items-center gap-1 rounded-md text-ui text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
          >
            All runs
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        ) : null
      }
    >
      {runs !== null && runs.length === 0 && isSdkOnly(data) ? (
        <div className="rounded-lg border border-line">
          <EmptyState
            emblem
            title="No traced runs yet"
            description="Your agent sends SDK events, not traces."
            action={
              <Link
                href={`${data.root}/traces/logs?range=${data.rangeParam}`}
                className={buttonVariants({ variant: "secondary", size: "sm" })}
              >
                See SDK events
              </Link>
            }
            secondary={
              <a href={DOCS_URL} target="_blank" rel="noreferrer" className={QUIET_LINK}>
                Add tracing
              </a>
            }
            className="px-4 py-8"
          />
        </div>
      ) : runs === null ? (
        <Callout tone="danger" title="Recent runs did not load">
          They are still in{" "}
          <Link
            href={tracesHref}
            className="text-fg underline decoration-line-strong underline-offset-4"
          >
            Traces
          </Link>
          .
        </Callout>
      ) : runs.length === 0 ? (
        <div className="rounded-lg border border-line">
          <EmptyState
            emblem
            title={`No runs in the last ${data.window} days`}
            description="Runs show up here as they arrive."
            action={
              data.window === 7 ? (
                <Link
                  href={`${data.root}?range=30d`}
                  className={buttonVariants({ variant: "secondary", size: "sm" })}
                >
                  Last 30 days
                </Link>
              ) : null
            }
            className="px-4 py-8"
          />
        </div>
      ) : (
        <RecentRunList runs={runs} tasks={data.runTasks} root={data.root} now={now} />
      )}
    </Section>
  );
}

export function RecentRunList({
  runs,
  tasks,
  root,
  now,
}: {
  runs: NonNullable<OverviewData["recentRuns"]>;
  /** Each run's task, by trace id, when one is known. */
  tasks: Readonly<Record<string, TaskRef>>;
  root: string;
  now: Date;
}) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
      {runs.map((run) => {
        const failed = run.statusCode === 2 || run.errorCount > 0;
        const task = tasks[run.traceId];
        return (
          <li key={run.traceId}>
            <Link
              href={`${root}/traces/${encodeURIComponent(run.traceId)}`}
              className="flex h-9 items-center gap-2 px-3 outline-none transition-colors duration-120 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
            >
              {task ? (
                <span className="flex min-w-0 flex-1">
                  <TaskPin name={task.name} slot={task.slot} className="shrink" />
                </span>
              ) : (
                <span className="min-w-0 flex-1 truncate text-ui text-fg-muted">
                  {run.rootName || "Unnamed run"}
                </span>
              )}
              {failed ? <Badge tone="danger">Failed</Badge> : null}
              <span className="shrink-0 text-xs text-fg-subtle tabular-nums">
                {formatDuration(run.durationMs)}
              </span>
              <time
                dateTime={run.startedAt.toISOString()}
                title={formatTimestamp(run.startedAt)}
                className="w-14 shrink-0 text-right text-xs text-fg-subtle tabular-nums"
              >
                {relativeTimeLabel(run.startedAt, now)}
              </time>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
