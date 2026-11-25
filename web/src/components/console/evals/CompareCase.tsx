"use client";

import { Badge, type Tone } from "@ratel/design-system/badge";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { Fragment, useId, useState } from "react";
// Not from the page model: that one has server code.
import { pairedTrials } from "@/lib/views/evals/domain/paired-trials";
import type { ComparedCaseRow, ComparedCaseSide, TrialView } from "@/lib/views/evals/page-model";
import { caseHref } from "@/lib/views/evals/paths";
import { CountBadges } from "./ExperimentList";
import { TrialPanel } from "./TrialPanel";

const CHANGE: Record<ComparedCaseRow["change"], { label: string; tone: Tone }> = {
  regressed: { label: "Regressed", tone: "danger" },
  improved: { label: "Improved", tone: "success" },
  inconclusive: { label: "Inconclusive", tone: "warning" },
  added: { label: "Added", tone: "info" },
  removed: { label: "Removed", tone: "info" },
  unchanged: { label: "Unchanged", tone: "neutral" },
};

/** One case: the counts of each side. It opens to the paired trials. */
export function CompareCase({ projectId, row }: { projectId: string; row: ComparedCaseRow }) {
  // The trials are not rendered before: each one reads its output and its tool calls.
  const [open, setOpen] = useState(false);
  const panel = useId();
  const change = CHANGE[row.change];
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
        className="group flex w-full flex-col gap-3 rounded-lg px-4 py-3 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span className="flex items-center gap-3">
          <ChevronRight
            aria-hidden
            className="size-3.5 shrink-0 text-fg-subtle transition-transform duration-160 group-aria-expanded:rotate-90 motion-reduce:transition-none"
          />
          <span className="min-w-0 truncate text-ui font-medium text-fg">{row.name}</span>
          <Badge tone={change.tone}>{change.label}</Badge>
        </span>
        <span className="grid gap-x-6 gap-y-2 pl-6.5 md:grid-cols-2">
          <SideSummary label="Baseline" side={row.baseline} />
          <SideSummary label="Candidate" side={row.candidate} />
        </span>
      </button>
      <div id={panel} hidden={!open}>
        {open ? <PairedTrials projectId={projectId} row={row} /> : null}
      </div>
    </>
  );
}

/** The evidence of one case: each baseline trial next to the candidate trial. */
export function PairedTrials({ projectId, row }: { projectId: string; row: ComparedCaseRow }) {
  const pairs = pairedTrials(row.baseline?.trials ?? null, row.candidate?.trials ?? null);
  return (
    <div className="border-t border-line px-4 py-4">
      <Link
        href={caseHref(projectId, row.caseId)}
        className="text-ui text-fg-muted underline underline-offset-2 hover:text-fg"
      >
        Open the case
      </Link>
      <div className="mt-3 grid gap-x-6 md:grid-cols-2">
        <h3 className="hidden text-ui font-semibold text-fg md:block">Baseline</h3>
        <h3 className="hidden text-ui font-semibold text-fg md:block">Candidate</h3>
        {pairs.map(({ index, baseline, candidate }) => (
          <Fragment key={index}>
            <Pane
              label="Baseline"
              projectId={projectId}
              trial={baseline}
              index={index}
              inExperiment={row.baseline !== null}
            />
            <Pane
              label="Candidate"
              projectId={projectId}
              trial={candidate}
              index={index}
              inExperiment={row.candidate !== null}
            />
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function SideSummary({ label, side }: { label: string; side: ComparedCaseSide | null }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
      <span className="w-16 text-ui text-fg-muted">{label}</span>
      {side ? (
        <>
          <span>v{side.number}</span>
          <CountBadges counts={side.counts} />
          {side.meanDurationMs === null ? null : (
            <span>{(side.meanDurationMs / 1000).toFixed(1)} s mean</span>
          )}
          {side.costUsd === null ? null : <span>${side.costUsd.toFixed(4)} total</span>}
        </>
      ) : (
        <span>Not in this experiment</span>
      )}
    </span>
  );
}

function Pane({
  label,
  projectId,
  trial,
  index,
  inExperiment,
}: {
  label: string;
  projectId: string;
  trial: TrialView | undefined;
  index: number;
  /** Whether the case is in the experiment of this side. */
  inExperiment: boolean;
}) {
  return (
    <div className="min-w-0 border-t border-line py-3">
      <h4 className="mb-2 text-xs text-fg-subtle md:sr-only">
        {label}, trial {index + 1}
      </h4>
      {trial ? (
        <TrialPanel projectId={projectId} trial={trial} loadEvidence />
      ) : (
        <p className="text-ui text-fg-subtle">
          {inExperiment ? "No trial with this number" : "Not in this experiment"}
        </p>
      )}
    </div>
  );
}
