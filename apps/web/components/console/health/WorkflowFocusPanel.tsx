import { CircleX, Clock3, Hammer, X } from "lucide-react";
import type { ReactNode } from "react";
import { OpenInTraces } from "@/components/console/health/OpenInTraces";
import { WorkflowSteps } from "@/components/console/health/WorkflowSteps";
import {
  failingStepText,
  slowestStepText,
  workflowExampleLabel,
} from "@/components/console/health/workflow-copy";
import type { WorkflowRowView } from "@/lib/readings/trace-signals/view";

export interface WorkflowFocusPanelProps {
  projectId: string;
  row: WorkflowRowView;
  /** Back to the map the viewer had before. */
  onClear: () => void;
}

/**
 * Under the flow map while it shows one workflow: its steps in order, the
 * step most failed runs stop at, the step that takes the most time, what to
 * build when the steps never change order, and a few runs to open in Traces.
 * Static once drawn: nothing in it unfolds or arrives later.
 */
export function WorkflowFocusPanel({ projectId, row, onClear }: WorkflowFocusPanelProps) {
  const failing = failingStepText(row);
  const slowest = slowestStepText(row);
  return (
    <section
      aria-label={`Workflow ${row.name}`}
      data-workflow-focus={row.id}
      className="mt-4 rounded-xl border border-forest-300/70 bg-base-deep/30 p-3 sm:p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-cream">{row.name}</h3>
          {row.description && (
            <p className="mt-0.5 text-[12px] leading-5 text-warm-muted">{row.description}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClear}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-warm-muted outline-none transition-colors hover:text-cream focus-visible:ring-2 focus-visible:ring-coral/60"
        >
          <X className="size-3.5" aria-hidden />
          Show the whole map
        </button>
      </div>
      <WorkflowSteps steps={row.steps} className="mt-3" />
      {(failing || slowest || row.build) && (
        <ul className="mt-3 flex flex-col gap-1.5 text-[12px] leading-5 text-warm-muted">
          {failing && (
            <Fact icon={<CircleX className="size-3.5 text-coral" aria-hidden />} text={failing} />
          )}
          {slowest && (
            <Fact
              icon={<Clock3 className="size-3.5 text-ctx-tools" aria-hidden />}
              text={slowest}
            />
          )}
          {row.build && (
            <Fact
              icon={<Hammer className="size-3.5 text-cream-dim" aria-hidden />}
              text={row.build}
            />
          )}
        </ul>
      )}
      {row.examples.length > 0 && (
        <div className="mt-3 border-t border-forest-300/50 pt-3">
          <h4 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-warm-muted">
            Example runs
          </h4>
          <ul className="grid gap-1 sm:grid-cols-2" data-workflow-examples="true">
            {row.examples.map((example) => (
              <li
                key={example.turnId}
                className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-forest-300/20"
              >
                <span className="text-[12px] text-cream-dim">{workflowExampleLabel(example)}</span>
                <OpenInTraces
                  projectId={projectId}
                  turn={{ turnId: example.turnId, steps: [] }}
                  focusEventId={example.focusEventId}
                  compact
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Fact({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5 inline-flex shrink-0">{icon}</span>
      <span>{text}</span>
    </li>
  );
}
