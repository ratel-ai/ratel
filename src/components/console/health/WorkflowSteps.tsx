import { cn } from "@ratel/design-system/cn";
import { ChevronRight } from "lucide-react";
import { ToolChip, type ToolChipTone } from "@/components/console/health/JourneyInsights";
import type { WorkflowToolView } from "@/lib/readings/trace-signals/view";

/** A step, optionally marked where failed runs stop (coral) or where the time goes (amber). */
export type WorkflowStepChip = WorkflowToolView & {
  mark?: ToolChipTone | null;
  note?: string | null;
};

/** A workflow's steps in their typical order, as the map's tool chips joined by chevrons. */
export function WorkflowSteps({
  steps,
  className,
}: {
  steps: readonly WorkflowStepChip[];
  className?: string;
}) {
  return (
    <ol
      aria-label={`Steps: ${steps.map((step) => step.label).join(", then ")}`}
      className={cn("flex min-w-0 flex-wrap items-center gap-1", className)}
    >
      {steps.map((step, i) => (
        <li key={`${step.id}-${i}`} className="inline-flex min-w-0 items-center gap-1">
          {i > 0 && <ChevronRight aria-hidden className="size-3 shrink-0 text-warm-muted/70" />}
          <ToolChip label={step.label} tone={step.mark} note={step.note} />
        </li>
      ))}
    </ol>
  );
}
