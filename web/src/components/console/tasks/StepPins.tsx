import { cn } from "@ratel/design-system/cn";
import { ToolPin } from "@ratel/design-system/entity";
import { ArrowRight } from "lucide-react";
import { Fragment } from "react";

export interface StepPin {
  /** Unique within the list (a tool can repeat in a run). */
  key: string;
  label: string;
  failed?: boolean;
  /** Back-to-back calls this pin stands for, shown as "×3" when more than one. */
  count?: number;
}

/**
 * Steps as tiny tool pins joined by arrows: what a task is (the tools it runs
 * one after another for one ask), shown instead of said. Past `max` the rest
 * fold into a count; `wideMax` shows more from the widest screens (2xl). On
 * a phone the pins wrap; from md they stay on one line and a pin never grows
 * past its share of the cell: its name truncates. A failed call wears the
 * danger color and says so to a screen reader. Tool names only.
 */
export function StepPins({
  steps,
  max = 3,
  wideMax,
  label = "Steps, in order",
  ordered = true,
  className,
}: {
  steps: readonly StepPin[];
  max?: number;
  wideMax?: number;
  label?: string;
  /** False for a set of tools with no order (the tools a fix changes): no arrows between them. */
  ordered?: boolean;
  className?: string;
}) {
  if (steps.length === 0) return null;
  const most = Math.max(max, wideMax ?? max);
  const shown = steps.slice(0, most);
  // Items past `max` only show on the widest screens.
  const wideOnly = (index: number) => index >= max;
  const folded = steps.length - max;
  const foldedWide = steps.length - most;
  const List = ordered ? "ol" : "ul";
  return (
    // A phone wraps the pins rather than cutting their names short; wider screens keep them on one line.
    <List
      aria-label={label}
      className={cn("flex min-w-0 flex-wrap items-center gap-1 md:flex-nowrap", className)}
      data-step-pins={steps.length}
    >
      {shown.map((step, index) => (
        <Fragment key={step.key}>
          {index > 0 && ordered ? (
            <li aria-hidden className={cn("shrink-0", wideOnly(index) && "hidden 2xl:block")}>
              <ArrowRight strokeWidth={1.5} className="size-3 text-fg-faint" />
            </li>
          ) : null}
          <li
            className={cn(
              "flex max-w-full min-w-12 items-center md:max-w-56 md:shrink",
              wideOnly(index) && "hidden 2xl:flex",
            )}
            data-step-failed={step.failed ? "true" : undefined}
          >
            <ToolPin
              name={step.label}
              className={cn(
                "h-5 gap-1 px-1",
                step.failed && "border-danger/40 bg-danger-subtle text-fg [&_svg]:text-danger",
              )}
            />
            {step.count && step.count > 1 ? (
              <span className="ml-1 shrink-0 text-xs text-fg-subtle tabular-nums">
                <span aria-hidden>×{step.count}</span>
                <span className="sr-only">, {step.count} times</span>
              </span>
            ) : null}
            {step.failed ? <span className="sr-only">, failed</span> : null}
          </li>
        </Fragment>
      ))}
      {folded > 0 ? (
        <Folded count={folded} className={most > max ? "2xl:hidden" : undefined} />
      ) : null}
      {most > max && foldedWide > 0 ? (
        <Folded count={foldedWide} className="hidden 2xl:block" />
      ) : null}
    </List>
  );
}

function Folded({ count, className }: { count: number; className?: string }) {
  return (
    <li className={cn("shrink-0 text-xs text-fg-subtle tabular-nums", className)}>
      <span aria-hidden>+{count}</span>
      <span className="sr-only">and {count} more</span>
    </li>
  );
}
