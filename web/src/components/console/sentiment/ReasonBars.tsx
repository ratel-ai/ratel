import { cn } from "@ratel/design-system/cn";
import { Tooltip } from "@ratel/design-system/tooltip";
import Link from "next/link";
import { percent, STATUS_COLOR } from "@/components/console/sentiment/copy";
import { formatCount } from "@/lib/readings/trace-signals/claims";
import type { ReasonChoiceView } from "@/lib/views/traces/sentiment/page-links";

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-focus";

/**
 * The reasons as a bar chart: every reason, the reasons tasks were not
 * completed, or the friction before tasks completed after it (a switch), then
 * one bar per reason, longest first within each result, colored by the
 * result it explains (the colors of Task completion). A bar narrows the
 * root causes below to its reason; picking it again lets it go.
 */
export function ReasonBars({
  statuses,
  reasons,
}: {
  statuses: readonly ReasonChoiceView[];
  reasons: readonly ReasonChoiceView[];
}) {
  if (statuses[0]?.tasks === 0) return null;
  const most = Math.max(1, ...reasons.map((reason) => reason.tasks));
  const total = reasons.reduce((sum, reason) => sum + reason.tasks, 0);
  return (
    <div className="flex flex-col gap-4" data-root-cause-reasons="">
      <nav
        aria-label="Reasons of"
        className="inline-flex w-fit max-w-full flex-wrap items-center gap-0.5 rounded-md border border-line bg-app p-0.5"
      >
        {statuses.map((status) => (
          <Link
            key={status.key}
            href={status.href}
            scroll={false}
            aria-current={status.active ? "true" : undefined}
            className={cn(
              "inline-flex h-6 items-center gap-1.5 rounded-[4px] px-2 text-ui font-medium whitespace-nowrap transition-colors duration-120",
              FOCUS,
              status.active ? "bg-selected text-fg" : "text-fg-muted hover:text-fg",
            )}
          >
            {status.key === "not_completed" || status.key === "completed_after_friction" ? (
              <span
                aria-hidden
                className={cn("size-2 rounded-[2px]", STATUS_COLOR[status.key].bg)}
              />
            ) : null}
            {status.label}
            <span className="text-xs text-fg-subtle tabular-nums">{formatCount(status.tasks)}</span>
          </Link>
        ))}
      </nav>
      <ul aria-label="Reasons" className="flex flex-col gap-1">
        {reasons.map((reason) => (
          <li key={reason.key}>
            <Tooltip content={reason.meaning ?? reason.label}>
              <Link
                href={reason.href}
                scroll={false}
                aria-current={reason.active ? "true" : undefined}
                className={cn(
                  "grid grid-cols-[minmax(8rem,14rem)_1fr_3rem_3rem] items-center gap-3 rounded-md px-2 py-1.5 text-ui transition-colors duration-120 max-sm:grid-cols-[minmax(6rem,9rem)_1fr_2.5rem]",
                  FOCUS,
                  reason.active ? "bg-selected" : "hover:bg-hover",
                )}
              >
                <span className={cn("truncate", reason.active ? "font-medium text-fg" : "text-fg")}>
                  {reason.label}
                </span>
                <span className="h-3 w-full rounded-[3px] bg-raised" aria-hidden>
                  <span
                    className={cn(
                      "block h-full rounded-[3px]",
                      reason.result ? STATUS_COLOR[reason.result].bg : "bg-fg-faint",
                    )}
                    style={{ width: `${Math.max(2, (reason.tasks / most) * 100)}%` }}
                  />
                </span>
                <span className="text-right text-fg tabular-nums">{formatCount(reason.tasks)}</span>
                <span className="text-right text-xs text-fg-subtle tabular-nums max-sm:hidden">
                  {percent(total === 0 ? 0 : reason.tasks / total)}
                </span>
              </Link>
            </Tooltip>
          </li>
        ))}
      </ul>
    </div>
  );
}
