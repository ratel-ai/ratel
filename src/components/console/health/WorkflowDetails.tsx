import { ArrowRight, CircleAlert, CircleX, Clock3, Cpu, Hammer, Route } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { OpenInTraces, TRACES_BUTTON } from "@/components/console/health/OpenInTraces";
import { useSharedSurface } from "@/components/console/health/surface";
import { WorkflowSteps } from "@/components/console/health/WorkflowSteps";
import { SEE_NEEDS_FIRST, workflowExpanded } from "@/components/console/health/workflow-row-model";
import type { WorkflowRowView } from "@/lib/readings/trace-signals/view";
import { taskHref } from "@/lib/views/tasks/paths";

export interface WorkflowDetailsProps {
  projectId: string;
  row: WorkflowRowView;
  /** Focuses the map on this workflow and brings it into view; absent when the map cannot focus. */
  onShowOnMap?: () => void;
}

/**
 * What an opened workflow row shows: what it does, what a run costs in the
 * model (when SDK runs are linked to OpenTelemetry), its steps (where failed
 * runs stop in coral, where the time goes in amber), one line each for its
 * top problem, what to build and the runs that asked for it and failed, and
 * the ways forward: its task page, the map focused on it, and an example run
 * in Traces.
 */
export function WorkflowDetails({ projectId, row, onShowOnMap }: WorkflowDetailsProps) {
  const view = workflowExpanded(row);
  // The public copy links nowhere inside the project.
  const publicCopy = useSharedSurface();
  return (
    <div
      data-workflow-details={row.id}
      className="flex flex-col gap-3 px-3 pb-4 pt-1 sm:pl-10 sm:pr-4"
    >
      <div className="flex flex-col gap-1">
        {view.description && (
          <p className="text-pretty text-[13px] leading-5 text-cream-dim">{view.description}</p>
        )}
        <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-warm-muted">
          {view.meta}
        </p>
        {view.model && (
          <p
            data-workflow-model="true"
            className="flex items-center gap-1.5 text-[12px] leading-5 text-cream-dim"
          >
            <Cpu aria-hidden className="size-3.5 shrink-0 text-warm-muted" />
            <span className="tabular-nums">{view.model}</span>
          </p>
        )}
      </div>
      <WorkflowSteps steps={view.steps} />
      {(view.problem || view.build || view.stoppedShort) && (
        <ul className="flex flex-col gap-1.5 text-[13px] leading-5 text-cream-dim">
          {view.problem && (
            <Fact
              data="problem"
              icon={
                view.problem.kind === "failing" ? (
                  <CircleX aria-hidden className="size-3.5 text-coral" />
                ) : (
                  <Clock3 aria-hidden className="size-3.5 text-ctx-tools" />
                )
              }
            >
              {view.problem.text}
            </Fact>
          )}
          {view.build && (
            <Fact data="build" icon={<Hammer aria-hidden className="size-3.5 text-ctx-memory" />}>
              <span className="text-cream">Build this: </span>
              {view.build}
            </Fact>
          )}
          {view.stoppedShort && (
            <Fact
              data="stopped-short"
              icon={<CircleAlert aria-hidden className="size-3.5 text-warm-muted" />}
            >
              <span className="text-warm-muted">{view.stoppedShort}</span>
            </Fact>
          )}
        </ul>
      )}
      {(!publicCopy || onShowOnMap || view.example) && (
        <div className="flex flex-wrap items-center gap-2">
          {!publicCopy && (
            <Link
              href={taskHref(projectId, row.id)}
              data-workflow-open-task="true"
              className={TRACES_BUTTON}
            >
              Open task
              <ArrowRight aria-hidden className="size-3.5 text-warm-muted" />
            </Link>
          )}
          {onShowOnMap && (
            <button
              type="button"
              data-workflow-show-map="true"
              onClick={onShowOnMap}
              className={TRACES_BUTTON}
            >
              <Route aria-hidden className="size-3.5 text-warm-muted" />
              {SEE_NEEDS_FIRST}
            </button>
          )}
          {view.example && (
            <OpenInTraces
              projectId={projectId}
              turn={{ turnId: view.example.turnId, steps: [] }}
              focusEventId={view.example.focusEventId}
              label={view.example.label}
              variant="button"
            />
          )}
        </div>
      )}
    </div>
  );
}

function Fact({ icon, data, children }: { icon: ReactNode; data: string; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2" data-workflow-fact={data}>
      <span className="mt-[3px] inline-flex shrink-0">{icon}</span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}
