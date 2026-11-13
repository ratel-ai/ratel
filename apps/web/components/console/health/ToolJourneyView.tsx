"use client";

import { useLayoutEffect, useMemo, useState } from "react";
import { CommonChains } from "@/components/console/health/JourneyInsights";
import {
  NEEDS_FIRST_ADVICE,
  NEEDS_FIRST_EMPTY,
  PREREQ_FILTER_LABEL,
  SHOW_ALL_LABEL,
} from "@/components/console/health/journey-copy";
import { PrepaintScript } from "@/components/console/health/PrepaintScript";
import { ToolJourneyCanvas } from "@/components/console/health/ToolJourneyCanvas";
import { ToolJourneyLegend } from "@/components/console/health/ToolJourneyLegend";
import { readStoredFlag, useStoredFlag } from "@/components/console/health/use-stored-flag";
import { WorkflowFocusPanel } from "@/components/console/health/WorkflowFocusPanel";
import { WORKFLOW_FOCUS_EMPTY, workflowFocusLine } from "@/components/console/health/workflow-copy";
import { useWorkflowFocus } from "@/components/console/health/workflow-focus";
import type {
  JourneyChain,
  PrerequisiteReading,
} from "@/lib/readings/trace-signals/flow-journey-insights";
import type { FlowJourney, WorkflowRowView } from "@/lib/readings/trace-signals/view";
import type { JourneyLayout } from "@/lib/views/health/flow-journey-layout";
import { workflowRelations } from "@/lib/views/health/flow-journey-workflow";

export interface ToolJourneyViewProps {
  journey: FlowJourney;
  /** The journey, laid out once with every link; the filter only hides parts of it. */
  layout: JourneyLayout;
  chains: readonly JourneyChain[];
  reading: PrerequisiteReading;
  /** One line of why, for when no tool clearly needs another first. */
  emptyReason: string | null;
  anchors: Readonly<Record<string, readonly string[]>>;
  /** Whether "Show all" starts on, before the viewer's own choice is read. */
  showAll?: boolean;
}

/** Kept per viewer: whether the map shows every turn, or only what each tool needs first. */
export const SHOW_ALL_KEY = "ratel.health.flowShowAll";

/**
 * No flash of the wrong map, however the page is reached.
 *
 * - A full page load: the server always draws the default (the filter), and
 *   the viewer's stored "Show all" is only known in the browser. This script
 *   runs while the page is parsed, before the first paint, and marks `<html>`
 *   when "Show all" is stored; the style hides the filtered map while that
 *   mark disagrees with it, until the browser renders the whole map.
 * - A soft navigation: the script does not run (`PrepaintScript`), and does
 *   not need to. The view renders on the client from the start, reading the
 *   stored choice synchronously (`useStoredFlag`), and a layout effect puts
 *   the mark in step before the first paint.
 *
 * With no stored choice nothing is hidden and nothing changes.
 */
export const SHOW_ALL_ATTRIBUTE = "data-flow-show-all";
export const SHOW_ALL_SCRIPT = `(function(){try{if(localStorage.getItem("${SHOW_ALL_KEY}")==="1")document.documentElement.setAttribute("${SHOW_ALL_ATTRIBUTE}","")}catch(e){}})();`;
export const SHOW_ALL_STYLE = `:root[${SHOW_ALL_ATTRIBUTE}] [data-flow-card-view="prerequisites"] [data-journey-canvas]{visibility:hidden}`;

/**
 * One map of every turn, filtered by default to what each tool needs first:
 * the two tools of each strong pair and the turns between them, in their
 * places. "Show all" fades the rest of the same map in (every tool, link,
 * "+N tools" and "Ended"), with the common chains under it; pointing at a
 * chain lights it on the map. With no pair to show, the map starts on
 * "Show all" and says why.
 */
export function ToolJourneyView({
  journey,
  layout,
  chains,
  reading,
  emptyReason,
  anchors,
  showAll = false,
}: ToolJourneyViewProps) {
  const [stored, setStored] = useStoredFlag(SHOW_ALL_KEY, showAll);
  const [chain, setChain] = useState<JourneyChain | null>(null);
  // A workflow picked in the Workflows list: the same filter, keeping only its steps.
  const shared = useWorkflowFocus();
  const workflow = shared?.focus ?? null;
  const steps = useMemo(
    () => (workflow ? workflowRelations(journey, workflow.focusTools) : []),
    [journey, workflow],
  );
  const focusing = workflow !== null && steps.length > 0;
  const hasPairs = reading.relations.length > 0;
  const all = !focusing && (stored || !hasPairs);
  // Keep the pre-paint mark in step with what is stored (never with a value still hydrating), before paint.
  useLayoutEffect(() => {
    document.documentElement.toggleAttribute(
      SHOW_ALL_ATTRIBUTE,
      readStoredFlag(SHOW_ALL_KEY, showAll),
    );
  }, [stored, showAll]);
  const leave = (showEverything: boolean) => {
    shared?.setFocus(null);
    setStored(showEverything);
  };
  const options: FilterOption[] = [
    ...(workflow
      ? [{ id: "workflow", label: "Task", on: true, disabled: false, pick: () => {} }]
      : []),
    {
      id: "prerequisites",
      label: PREREQ_FILTER_LABEL,
      on: !workflow && !all,
      disabled: !hasPairs,
      pick: () => leave(false),
    },
    {
      id: "all",
      label: SHOW_ALL_LABEL,
      on: !workflow && all,
      disabled: false,
      pick: () => leave(true),
    },
  ];
  const view = focusing ? "workflow" : all ? "all" : "prerequisites";
  return (
    <div className="mt-4" data-flow-card-view={view}>
      <style dangerouslySetInnerHTML={{ __html: SHOW_ALL_STYLE }} />
      <PrepaintScript name="flow-show-all" code={SHOW_ALL_SCRIPT} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <FilterLine
          workflow={workflow}
          focusing={focusing}
          hasPairs={hasPairs}
          emptyReason={emptyReason}
        />
        <FilterSwitch options={options} />
      </div>
      <ToolJourneyCanvas
        journey={journey}
        layout={layout}
        anchors={anchors}
        showAll
        filtered={!all}
        prerequisites={focusing ? steps : reading.relations}
        chain={all ? chain : null}
        unfoldTools={focusing ? workflow.focusTools : undefined}
      />
      {workflow && shared && (
        <WorkflowFocusPanel
          projectId={shared.projectId}
          row={workflow}
          onClear={() => shared.setFocus(null)}
        />
      )}
      {!workflow && all && (
        <>
          <ToolJourneyLegend />
          <section aria-label="Common chains" data-flow-chains="true" className="mt-4">
            <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-warm-muted">
              Common chains
            </h3>
            <CommonChains chains={chains} active={chain} onPoint={setChain} />
          </section>
        </>
      )}
    </div>
  );
}

/** The line beside the switch: the workflow in focus, what to do about a pair, or why there is none. */
function FilterLine({
  workflow,
  focusing,
  hasPairs,
  emptyReason,
}: {
  workflow: WorkflowRowView | null;
  focusing: boolean;
  hasPairs: boolean;
  emptyReason: string | null;
}) {
  if (workflow) {
    return (
      <p data-workflow-focus-line="true" className="max-w-2xl text-xs leading-5 text-warm-muted">
        <span className="text-cream-dim">
          {focusing ? workflowFocusLine(workflow) : WORKFLOW_FOCUS_EMPTY}
        </span>
      </p>
    );
  }
  if (hasPairs) {
    return (
      <p data-prereq-advice="true" className="max-w-2xl text-xs leading-5 text-warm-muted">
        <span className="font-medium text-cream-dim">What to do: </span>
        {NEEDS_FIRST_ADVICE}
      </p>
    );
  }
  return (
    <p data-prereq-empty="true" className="max-w-2xl text-xs leading-5 text-warm-muted">
      <span className="text-cream-dim">{NEEDS_FIRST_EMPTY}</span>
      {emptyReason && <> {emptyReason}</>}
    </p>
  );
}

interface FilterOption {
  id: string;
  label: string;
  on: boolean;
  disabled: boolean;
  pick: () => void;
}

/** What the map shows, as one segmented switch. */
function FilterSwitch({ options }: { options: readonly FilterOption[] }) {
  return (
    <div
      role="radiogroup"
      aria-label="What the map shows"
      className="inline-flex shrink-0 rounded-full border border-forest-300 bg-base-deep/40 p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={option.on}
          disabled={option.disabled}
          data-flow-filter={option.id}
          title={option.disabled ? NEEDS_FIRST_EMPTY : undefined}
          onClick={option.pick}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-coral disabled:cursor-not-allowed disabled:opacity-40 ${
            option.on ? "bg-cream text-ink" : "text-warm-muted enabled:hover:text-cream"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
