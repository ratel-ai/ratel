import { Check, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../cn";

export type StepState = "done" | "current" | "todo" | "problem";

export type Step = {
  id: string;
  title: ReactNode;
  /** One or two sentences: what this step is, or what is wrong with it. */
  description?: ReactNode;
  state: StepState;
  /** A snippet or a link under the description. */
  children?: ReactNode;
};

const STATE_WORD: Record<StepState, string> = {
  done: "Done",
  current: "Next",
  todo: "Waiting",
  problem: "Needs a change",
};

/**
 * A short, numbered checklist (first-run and setup states). Visible, never
 * folded away: a page with nothing to show yet shows how it fills instead.
 * Each step says its state in a word as well as a mark.
 */
export function Steps({
  steps,
  label,
  className,
}: {
  steps: readonly Step[];
  label: string;
  className?: string;
}) {
  return (
    <ol aria-label={label} className={cn("flex flex-col", className)}>
      {steps.map((step, index) => (
        <li key={step.id} data-state={step.state} className="relative flex gap-3 pb-6 last:pb-0">
          {index < steps.length - 1 ? (
            <span aria-hidden className="absolute top-7 bottom-1 left-[11px] w-px bg-line" />
          ) : null}
          <span
            aria-hidden
            className={cn(
              "relative inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums",
              step.state === "done" && "border-transparent bg-success-subtle text-success",
              step.state === "problem" && "border-transparent bg-warning-subtle text-warning",
              step.state === "current" && "border-line-active bg-raised text-fg",
              step.state === "todo" && "border-line bg-app text-fg-subtle",
            )}
          >
            {step.state === "done" ? (
              <Check className="size-3.5" strokeWidth={2} />
            ) : step.state === "problem" ? (
              <TriangleAlert className="size-3.5" strokeWidth={2} />
            ) : (
              index + 1
            )}
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="flex items-baseline gap-2">
              <p
                className={cn(
                  "text-sm font-medium",
                  step.state === "todo" ? "text-fg-muted" : "text-fg",
                )}
              >
                {step.title}
              </p>
              <span
                className={cn(
                  "text-xs",
                  step.state === "problem" ? "text-warning" : "text-fg-subtle",
                )}
              >
                {STATE_WORD[step.state]}
              </span>
            </div>
            {step.description ? (
              <p className="mt-0.5 max-w-2xl text-ui text-fg-muted">{step.description}</p>
            ) : null}
            {step.children ? <div className="mt-3">{step.children}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
