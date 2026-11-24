import { cn } from "@ratel/design-system/cn";
import { Section } from "@ratel/design-system/section";
import { Tooltip } from "@ratel/design-system/tooltip";
import { ListChecks } from "lucide-react";
import { NounTitle } from "@/components/console/health/v2/NounTitle";
import { percent, plural, STATUS_COLOR } from "@/components/console/sentiment/copy";
import { RootCauseLink } from "@/components/console/sentiment/RootCausesHost";
import { SatisfactionScore } from "@/components/console/sentiment/SatisfactionScore";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import type { Overview } from "@/lib/views/traces/sentiment/overview";
import { TASK_FILTER_LABEL, TASK_FILTER_MEANING } from "@/lib/views/traces/sentiment/page-kinds";
import type { TaskFilter } from "@/lib/views/traces/sentiment/page-paths";

const HEAD = "py-2 font-medium";

/**
 * How satisfied people were in each task status: satisfied of the turns
 * people said how it went in tasks that were completed, completed after
 * friction, or not completed. Why they ended that way opens in the Root cause
 * analysis panel, as from task completion on Agent health.
 */
export function SatisfactionByStatus({
  overview,
  hrefOf,
}: {
  overview: Overview;
  /** The root causes of a status, for the two that need explaining; null for the rest. */
  hrefOf: (filter: TaskFilter) => string | null;
}) {
  if (overview.satisfaction.answers === 0) return null;
  return (
    <Section title={<NounTitle icon={ListChecks}>Satisfaction by task status</NounTitle>}>
      <table className="w-full table-fixed text-left text-ui" data-sentiment-by-status="">
        <caption className="sr-only">Satisfaction by task status</caption>
        <thead className="border-b border-line text-xs text-fg-subtle">
          <tr>
            <th scope="col" className={HEAD}>
              Task status
            </th>
            <th scope="col" className={cn(HEAD, "w-28 text-right max-sm:hidden")}>
              Tasks
            </th>
            <th scope="col" className={cn(HEAD, "w-40 pl-3 text-right sm:w-56")}>
              Satisfaction
            </th>
            <th scope="col" className={cn(HEAD, "w-28 pl-3 text-right max-sm:hidden")}>
              Based on
            </th>
          </tr>
        </thead>
        <tbody>
          {overview.statuses.map((status) => (
            <tr
              key={status.filter}
              className={cn(
                "relative border-b border-line",
                hrefOf(status.filter) && "transition-colors duration-120 hover:bg-hover",
              )}
              data-satisfaction-status={status.filter}
            >
              <td className="py-2">
                <span className="flex min-w-0 items-center gap-3">
                  <span
                    aria-hidden
                    className={cn("size-2 shrink-0 rounded-[2px]", STATUS_COLOR[status.filter].bg)}
                  />
                  <Tooltip content={TASK_FILTER_MEANING[status.filter]}>
                    <StatusLabel filter={status.filter} href={hrefOf(status.filter)} />
                  </Tooltip>
                </span>
              </td>
              <td className="py-2 text-right text-fg-muted tabular-nums max-sm:hidden">
                {formatCount(status.tasks)}
              </td>
              <td className="py-2 pl-3 text-right">
                {status.score === null ? (
                  <span className="text-xs text-fg-subtle">No answers</span>
                ) : (
                  <SatisfactionScore score={status.score} />
                )}
              </td>
              <td className="py-2 pl-3 text-right text-xs text-fg-subtle tabular-nums max-sm:hidden">
                {status.answers === 0 ? "None" : plural(status.answers, "answer")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

/** A status, as on Agent health: the two that need explaining open their root causes, the whole row with them. */
function StatusLabel({ filter, href, ...rest }: { filter: TaskFilter; href: string | null }) {
  return href ? (
    <RootCauseLink
      {...rest}
      href={href}
      className="truncate rounded-sm text-fg outline-none after:absolute after:inset-0 focus-visible:ring-2 focus-visible:ring-focus"
      data-satisfaction-status-open={filter}
    >
      {TASK_FILTER_LABEL[filter]}
    </RootCauseLink>
  ) : (
    <span {...rest} className="truncate text-fg">
      {TASK_FILTER_LABEL[filter]}
    </span>
  );
}
