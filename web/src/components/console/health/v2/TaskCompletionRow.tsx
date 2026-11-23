import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { Section } from "@ratel/design-system/section";
import { ArrowRight, ListChecks } from "lucide-react";
import Link from "next/link";
import { GROUP_COLOR, GROUP_SHORT } from "@/components/console/hallucinations/copy";
import { NounTitle } from "@/components/console/health/v2/NounTitle";
import { StatusRing } from "@/components/console/health/v2/StatusRing";
import { percent, plural, STATUS_COLOR } from "@/components/console/sentiment/copy";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import { GROUP_LABEL } from "@/lib/readings/trace-signals/hallucinations/kinds";
import { windowPhrase } from "@/lib/readings/trace-signals/view";
import type { HallucinationRateCard } from "@/lib/views/health/hallucinations/rate-card";
import type { TaskCompletionCard } from "@/lib/views/health/root-causes/completion-card";
import { TASK_FILTER_LABEL, TASK_FILTER_MEANING } from "@/lib/views/traces/sentiment/page-kinds";

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-focus";

/**
 * Task completion on the Summary, right above the issues: the window's tasks
 * as a ring by status with the share completed in the middle (pointing at a
 * slice shows its share), each status
 * beside it with its share, and, when hallucination detection is on, the
 * hallucination rate next to them. A task is a goal (the person's request,
 * or the agent's own tool search) and the work after it. Completed after
 * friction and not completed open Root cause analysis narrowed to them.
 */
export function TaskCompletionRow({
  card,
  hallucinations = null,
}: {
  card: TaskCompletionCard;
  hallucinations?: HallucinationRateCard | null;
}) {
  const completed = card.statuses.find((status) => status.filter === "completed")?.share ?? 0;
  return (
    <Section title={<NounTitle icon={ListChecks}>Task completion</NounTitle>}>
      <div
        className="flex flex-wrap items-stretch gap-6"
        data-health-task-completion={card.total > 0 ? "ready" : "none"}
      >
        {card.total === 0 ? (
          <p className="flex-1 text-ui text-fg-muted">
            No tasks read {windowPhrase(card.windowDays)}. They show up after the next reading of
            your agent&apos;s runs.
          </p>
        ) : (
          <div className="flex min-w-0 flex-col gap-2">
            {/* Root causes belong to task completion: the link sits on its own part, not over the hallucination rate. */}
            <div className="flex items-center justify-between gap-3">
              <span className="text-ui text-fg-muted">{`${plural(card.total, "task")} ${windowPhrase(card.windowDays)}`}</span>
              <Link
                href={card.href}
                className={buttonVariants({ variant: "ghost", size: "sm" })}
                data-task-completion-open=""
              >
                See root causes
                <ArrowRight aria-hidden />
              </Link>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-4">
              <StatusRing
                label="Tasks by status"
                total={percent(completed)}
                unit="completed"
                slices={card.statuses.map((status) => ({
                  key: status.filter,
                  label: TASK_FILTER_LABEL[status.filter],
                  value: status.tasks,
                  share: status.share,
                  color: STATUS_COLOR[status.filter].fill,
                  href: status.href,
                }))}
              />
              <ul className="flex w-full flex-col gap-1 sm:w-[24rem]" aria-label="Tasks by status">
                {card.statuses.map((status) => {
                  const cells = (
                    <>
                      <span className="flex min-w-0 items-center gap-2 text-fg">
                        <span
                          aria-hidden
                          className={cn(
                            "size-2.5 shrink-0 rounded-[2px]",
                            STATUS_COLOR[status.filter].bg,
                          )}
                        />
                        <span className="truncate">{TASK_FILTER_LABEL[status.filter]}</span>
                      </span>
                      <span className="text-right text-fg-muted tabular-nums">
                        {plural(status.tasks, "task")}
                      </span>
                      <span className="text-right font-medium text-fg tabular-nums">
                        {percent(status.share)}
                      </span>
                    </>
                  );
                  const row =
                    "grid grid-cols-[1fr_6rem_3.5rem] items-center gap-3 rounded-md px-2 py-1.5 text-ui";
                  return (
                    <li
                      key={status.filter}
                      title={TASK_FILTER_MEANING[status.filter]}
                      data-task-status={status.filter}
                    >
                      {status.href ? (
                        <Link
                          href={status.href}
                          className={cn(
                            row,
                            FOCUS,
                            "transition-colors duration-120 hover:bg-hover",
                          )}
                        >
                          {cells}
                        </Link>
                      ) : (
                        <div className={row}>{cells}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}
        {hallucinations ? (
          <HallucinationRateTile card={hallucinations} windowDays={card.windowDays} />
        ) : null}
      </div>
    </Section>
  );
}

/**
 * The hallucination rate beside task completion: the share of turns with
 * one, and each group's part as a bar (a group that could not be checked
 * says so). It takes the rest of the row, with no box: a heading line and
 * its link, like task completion beside it.
 */
function HallucinationRateTile({
  card,
  windowDays,
}: {
  card: HallucinationRateCard;
  windowDays: TaskCompletionCard["windowDays"];
}) {
  const value =
    !card.checked && card.read
      ? "Not checked"
      : card.rate === null
        ? "None"
        : card.rate > 0 && card.rate < 0.001
          ? "<0.1%"
          : card.rate < 0.1
            ? `${(card.rate * 100).toFixed(1)}%`
            : percent(card.rate);
  const hint = !card.read
    ? "Not read yet"
    : !card.checked
      ? "This project sends nothing the rules can read"
      : card.turns === 0
        ? `No turns ${windowPhrase(windowDays)}`
        : `${formatCount(card.turnsAffected)} of ${plural(card.turns, "turn")} had at least one`;
  const found = card.groups.filter((group) => group.occurrences > 0);
  return (
    <div className="flex min-w-[16rem] flex-1 flex-col gap-3" data-health-hallucination-rate="">
      {/* Laid out like task completion beside it: a heading line with its link, no box. */}
      <div className="flex items-center justify-between gap-3">
        <span className="text-ui text-fg-muted">Hallucination rate</span>
        <Link
          href={card.href}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
          data-health-hallucination-open=""
        >
          See all
          <ArrowRight aria-hidden />
        </Link>
      </div>
      <span className="flex flex-col gap-0.5">
        <span
          className={cn(
            "font-semibold tabular-nums",
            card.checked ? "text-3xl text-fg" : "text-2xl text-fg-muted",
          )}
        >
          {value}
        </span>
        <span className="text-xs text-fg-subtle">{hint}</span>
      </span>
      {card.read ? (
        <>
          {/* Each group's part of the occurrences. */}
          <span className="flex flex-col gap-1.5" data-health-hallucination-groups="">
            <span
              role="img"
              aria-label={`By group: ${card.groups.map((group) => `${GROUP_LABEL[group.group]} ${group.checked ? group.occurrences : "not checked"}`).join(", ")}`}
              className="flex h-2 w-full gap-[2px] overflow-hidden rounded-[4px] bg-hover"
            >
              {found.map((group) => (
                <span
                  key={group.group}
                  aria-hidden
                  className={cn("h-full min-w-[3px]", GROUP_COLOR[group.group])}
                  style={{ flexGrow: group.occurrences, flexBasis: 0 }}
                />
              ))}
            </span>
            <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
              {card.groups.map((group) => (
                <span
                  key={group.group}
                  className={cn(
                    "inline-flex items-center gap-1.5",
                    group.checked ? "text-fg-muted" : "text-fg-subtle",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-2 rounded-[2px]",
                      group.checked ? GROUP_COLOR[group.group] : "border border-line-strong",
                    )}
                  />
                  {GROUP_SHORT[group.group]}
                  <span className="tabular-nums">
                    {group.checked ? formatCount(group.occurrences) : "not checked"}
                  </span>
                </span>
              ))}
            </span>
          </span>
        </>
      ) : null}
    </div>
  );
}
