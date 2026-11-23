import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { Section } from "@ratel/design-system/section";
import { type StatProps, StatRow } from "@ratel/design-system/stat-row";
import { ArrowRight, ListChecks } from "lucide-react";
import Link from "next/link";
import { NounTitle } from "@/components/console/health/v2/NounTitle";
import { percent, plural, STATUS_COLOR } from "@/components/console/sentiment/copy";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import { windowPhrase } from "@/lib/readings/trace-signals/view";
import type { TaskCompletionCard } from "@/lib/views/health/root-causes/completion-card";
import { TASK_FILTER_LABEL, TASK_FILTER_MEANING } from "@/lib/views/traces/sentiment/page-kinds";

/**
 * Task completion on the Summary, right above the issues: the window's tasks
 * as one bar by status, then each status's share. A task is a goal (the
 * person's request, or the agent's own tool search) and the work after it.
 * Completed after friction and not completed open Root cause analysis
 * narrowed to them. Server-safe: no client state.
 */
export function TaskCompletionRow({ card }: { card: TaskCompletionCard }) {
  const shown = card.statuses.filter((status) => status.tasks > 0);
  return (
    <Section
      title={<NounTitle icon={ListChecks}>Task completion</NounTitle>}
      actions={
        card.total > 0 ? (
          <Link
            href={card.href}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
            data-task-completion-open=""
          >
            See root causes
            <ArrowRight aria-hidden />
          </Link>
        ) : null
      }
    >
      <div
        className="flex flex-col gap-3"
        data-health-task-completion={card.total > 0 ? "ready" : "none"}
      >
        {card.total === 0 ? (
          <p className="text-ui text-fg-muted">
            No tasks read {windowPhrase(card.windowDays)}. They show up after the next reading of
            your agent&apos;s runs.
          </p>
        ) : (
          <>
            <div
              role="img"
              aria-label={`Tasks by status: ${shown.map((status) => `${TASK_FILTER_LABEL[status.filter]} ${percent(status.share)}`).join(", ")}`}
              className="flex h-2 w-full gap-[2px]"
            >
              {shown.map((status) => (
                <span
                  key={status.filter}
                  aria-hidden
                  className={cn(
                    "h-full min-w-[3px] first:rounded-l-[4px] last:rounded-r-[4px]",
                    STATUS_COLOR[status.filter].bg,
                  )}
                  style={{ flexGrow: status.tasks, flexBasis: 0 }}
                />
              ))}
            </div>
            <StatRow
              stats={card.statuses.map(
                (status): StatProps => ({
                  label: TASK_FILTER_LABEL[status.filter],
                  value: (
                    <span
                      className="inline-flex items-center gap-2"
                      title={TASK_FILTER_MEANING[status.filter]}
                    >
                      <span
                        aria-hidden
                        className={cn("size-2.5 rounded-[2px]", STATUS_COLOR[status.filter].bg)}
                      />
                      {percent(status.share)}
                    </span>
                  ),
                  hint: status.href
                    ? `${plural(status.tasks, "task")} · see why`
                    : `${formatCount(status.tasks)} of ${plural(card.total, "task")}`,
                  ...(status.href ? { href: status.href } : {}),
                }),
              )}
            />
          </>
        )}
      </div>
    </Section>
  );
}
