import { cn } from "@ratel/design-system/cn";
import { DotMeter } from "@ratel/design-system/dot-matrix";
import { ToolPin } from "@ratel/design-system/entity";
import { PeekLink } from "@ratel/design-system/panel";
import { TASK_COLOR_CLASSES, type TaskColorSlot } from "@ratel/design-system/task-colors";
import { ChevronRight, CircleX, Timer } from "lucide-react";
import { CORRECTION_ICONS, KindIcon } from "@/components/console/tasks/kind-icons";
import { formatCount, formatMs, formatShare } from "@/lib/views/tasks/format";
import type { StepView } from "@/lib/views/tasks/model";
import { stepPeek } from "@/lib/views/tasks/paths";

/**
 * A task's pipeline as a drawing: its steps as large tool pins joined by a
 * line in the task's color, left to right (top to bottom on a phone). Under
 * each pin, its failure meter, its retries and its typical time; the step
 * that fails most (or takes the time, on a slow task) wears the danger (or
 * warning) color with an icon and a word. A pin opens the step's panel
 * (`?peek=step:<tool>`) with the rest of its numbers. The tools some runs add
 * sit after it as smaller pins. Tool names and numbers only.
 */
export function TaskPipeline({
  steps,
  sideSteps,
  hasReading,
  color,
}: {
  steps: readonly StepView[];
  sideSteps: readonly StepView[];
  hasReading: boolean;
  color: TaskColorSlot | null;
}) {
  const line = TASK_COLOR_CLASSES[color ?? "neutral"];
  return (
    <div className="flex flex-col gap-5">
      <div className="overflow-x-auto pb-1">
        <ol
          aria-label="Steps, in order"
          className="flex flex-col md:flex-row"
          data-task-steps={steps.length}
        >
          {steps.map((step, index) => (
            <StepNode
              key={step.toolId}
              step={step}
              index={index}
              last={index === steps.length - 1}
              hasReading={hasReading}
              line={line}
            />
          ))}
        </ol>
      </div>
      {sideSteps.length > 0 ? <SideSteps steps={sideSteps} hasReading={hasReading} /> : null}
    </div>
  );
}

const MARK: Readonly<
  Record<
    NonNullable<StepView["mark"]>,
    { word: string; icon: typeof CircleX; text: string; pin: string }
  >
> = {
  failing: {
    word: "Fails most",
    icon: CircleX,
    text: "text-danger",
    pin: "border-danger/50 bg-danger-subtle text-fg [&_svg]:text-danger",
  },
  slow: {
    word: "Takes the most time",
    icon: Timer,
    text: "text-warning",
    pin: "border-warning/50 bg-warning-subtle text-fg [&_svg]:text-warning",
  },
};

const PIN_LINK =
  "relative z-10 max-w-full self-start rounded-md bg-app outline-none focus-visible:ring-2 focus-visible:ring-focus";

function StepNode({
  step,
  index,
  last,
  hasReading,
  line,
}: {
  step: StepView;
  index: number;
  last: boolean;
  hasReading: boolean;
  line: (typeof TASK_COLOR_CLASSES)[keyof typeof TASK_COLOR_CLASSES];
}) {
  const mark = step.mark ? MARK[step.mark] : null;
  return (
    <li
      className="relative flex min-w-0 flex-col gap-2 pb-6 last:pb-0 md:max-w-80 md:shrink-0 md:pr-14 md:pb-0 md:last:pr-0"
      data-task-step={step.toolId}
      data-step-mark={step.mark ?? undefined}
    >
      {!last ? (
        <>
          {/* The line in the task's color: down to the next pin on a phone, across to it from md. */}
          <span
            aria-hidden
            data-step-line=""
            className={cn(
              "absolute top-8 bottom-0 left-3.5 w-0.5 rounded-full md:top-[15px] md:right-0 md:bottom-auto md:left-0 md:h-0.5 md:w-auto",
              line.bg,
            )}
          />
          <ChevronRight
            aria-hidden
            strokeWidth={2}
            className={cn("absolute top-2 right-0 hidden size-4 md:block", line.stroke)}
          />
        </>
      ) : null}
      <PeekLink peek={stepPeek(step.toolId)} className={PIN_LINK}>
        <span className="sr-only">Step {index + 1}: </span>
        <ToolPin
          name={step.label}
          className={cn("h-8 gap-2 px-2.5 text-ui [&_svg]:size-3.5", mark?.pin)}
        />
        {mark ? <span className="sr-only">, {mark.word.toLowerCase()}</span> : null}
      </PeekLink>
      {/* On a phone the line runs down the left gutter, so the numbers sit to its right. */}
      {mark || hasReading ? (
        <div className="flex flex-col gap-2 pl-8 md:pl-0.5">
          {mark ? (
            <span
              className={cn("inline-flex items-center gap-1 text-xs font-medium", mark.text)}
              aria-hidden
            >
              <mark.icon strokeWidth={1.5} className="size-3.5 shrink-0" />
              {mark.word}
            </span>
          ) : null}
          {hasReading ? <StepFacts step={step} /> : null}
        </div>
      ) : null}
    </li>
  );
}

/** The three numbers a step carries on the drawing; the rest wait in its panel. */
function StepFacts({ step }: { step: StepView }) {
  const share = step.failureShare ?? 0;
  return (
    <dl className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
      <div className="flex basis-full items-center">
        <dt className="sr-only">Fails</dt>
        <dd className="flex items-center gap-2">
          <DotMeter
            value={share}
            cells={10}
            tone={step.failures > 0 ? "danger" : "neutral"}
            label={`Fails ${formatShare(share)} of its calls`}
          />
          <span>
            <span className="text-fg tabular-nums">{formatShare(share)}</span> fail
          </span>
        </dd>
      </div>
      <div className="flex items-center">
        <dt className="sr-only">Retried</dt>
        <dd className="inline-flex items-center gap-1">
          <KindIcon icon={CORRECTION_ICONS.retry_after_error} />
          <span>
            <span className="text-fg tabular-nums">{formatCount(step.retries)}</span>{" "}
            {step.retries === 1 ? "retry" : "retries"}
          </span>
        </dd>
      </div>
      <div className="flex items-center">
        <dt className="sr-only">Typical time</dt>
        <dd className="inline-flex items-center gap-1">
          <KindIcon icon={Timer} />
          <span className="text-fg tabular-nums">{formatMs(step.medianMs)}</span>
        </dd>
      </div>
      {step.runShare < 0.995 ? (
        <div className="flex basis-full items-center">
          <dt className="sr-only">Runs</dt>
          <dd>
            in <span className="text-fg tabular-nums">{formatShare(step.runShare)}</span> of runs
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

/** Tools some runs add: smaller pins, each with the share of runs that called it. */
function SideSteps({ steps, hasReading }: { steps: readonly StepView[]; hasReading: boolean }) {
  return (
    <section
      aria-label="Tools some runs add"
      className="flex flex-wrap items-center gap-x-4 gap-y-2"
      data-task-side-steps={steps.length}
    >
      <h3 className="text-xs font-medium text-fg-subtle">Sometimes adds</h3>
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {steps.map((step) => (
          <li
            key={step.toolId}
            className="flex items-center gap-1.5"
            data-task-side-step={step.toolId}
          >
            <PeekLink
              peek={stepPeek(step.toolId)}
              className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <ToolPin
                name={step.label}
                className={cn("max-w-48", step.mark ? MARK[step.mark].pin : undefined)}
              />
            </PeekLink>
            {hasReading ? (
              <span className="text-xs text-fg-subtle tabular-nums">
                {step.role === "helper" ? "helper, " : ""}
                {formatShare(step.runShare)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
