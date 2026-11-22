import { cn } from "@ratel/design-system/cn";
import { Tooltip } from "@ratel/design-system/tooltip";
import { Lock } from "lucide-react";
import Link from "next/link";
import { planName, planWithWindow } from "@/lib/platform/entitlements";
import {
  agentHealthHref,
  type WindowDays,
  type WindowOption,
} from "@/lib/readings/trace-signals/view";

/**
 * 7, 30 or 90 days, as links (the window is URL state, `?days=`), in the segmented look every
 * page uses. A window the organization's limits exclude is not a link: it says which plan has
 * it. Owned (ADR-0004): the plan comes from the edition's plans; without them, the window is
 * said to be outside the limits.
 */
export function WindowSwitch({
  projectId,
  windowDays,
  options,
}: {
  projectId: string;
  windowDays: WindowDays;
  options: readonly WindowOption[];
}) {
  if (options.length === 0) return null;
  const item =
    "inline-flex h-6 items-center gap-1 rounded-[4px] px-2 text-ui font-medium whitespace-nowrap outline-none transition-colors duration-120 focus-visible:ring-2 focus-visible:ring-focus";
  return (
    <nav
      aria-label="Time window"
      className="inline-flex items-center gap-0.5 rounded-md border border-line bg-app p-0.5"
      data-health-window={windowDays}
    >
      {options.map((option) => {
        if (option.locked) {
          const plan = planWithWindow(option.days);
          const name = plan ? planName(plan) : null;
          return (
            <Tooltip
              key={option.days}
              content={
                name
                  ? `${option.days} days are on ${name}`
                  : `${option.days} days are outside this project's limits`
              }
            >
              <span
                tabIndex={0}
                aria-disabled="true"
                className={cn(item, "cursor-not-allowed text-fg-faint")}
                data-health-window-locked={option.days}
              >
                {option.days} days
                <Lock aria-hidden className="size-3" />
                <span className="sr-only">{name ? `, on ${name}` : ", not included"}</span>
              </span>
            </Tooltip>
          );
        }
        const active = option.days === windowDays;
        return (
          <Link
            key={option.days}
            href={agentHealthHref(projectId, option.days)}
            scroll={false}
            aria-current={active ? "true" : undefined}
            className={cn(item, active ? "bg-selected text-fg" : "text-fg-muted hover:text-fg")}
          >
            {option.days} days
          </Link>
        );
      })}
    </nav>
  );
}
