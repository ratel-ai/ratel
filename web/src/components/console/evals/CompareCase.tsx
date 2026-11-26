"use client";

import { Badge, type Tone } from "@ratel/design-system/badge";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { Fragment, useId, useState } from "react";
// Not from the page model: that one has server code.
import { type DiffSpan, diffWords } from "@/lib/synthesis/match-quality/diff";
import { pairedTrials } from "@/lib/views/evals/domain/paired-trials";
import type { ScorerResult } from "@/lib/views/evals/domain/score";
import type { ComparedCaseRow, ComparedCaseSide, GridTrial } from "@/lib/views/evals/page-model";
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

const SCORER_TONE: Record<ScorerResult["status"], Tone> = {
  pass: "success",
  fail: "danger",
  not_scored: "warning",
};

/**
 * One case: the counts of each side. A changed case shows the two outputs side by side with a word
 * diff. It opens to the paired trials.
 */
export function CompareCase({
  projectId,
  row,
  showOutputs = false,
}: {
  projectId: string;
  row: ComparedCaseRow;
  showOutputs?: boolean;
}) {
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
      {showOutputs ? <OutputDiff row={row} /> : null}
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

/** The output of a trial on each side, the words that changed marked. */
export function OutputDiff({ row }: { row: ComparedCaseRow }) {
  const pairs = pairedTrials(row.baseline?.trials ?? null, row.candidate?.trials ?? null);
  const [at, setAt] = useState(0);
  const pair = pairs[at] ?? pairs[0];
  if (!pair) return null;
  const before = pair.baseline?.output ?? "";
  const after = pair.candidate?.output ?? "";
  const spans = diffWords(before, after);
  return (
    <div className="flex flex-col gap-2 px-4 pb-4 pl-10.5">
      {pairs.length > 1 ? (
        <div
          className="flex items-center gap-1"
          role="toolbar"
          aria-label={`Trials of ${row.name}`}
        >
          <span className="mr-1 text-xs text-fg-subtle">Trial</span>
          {pairs.map(({ index }, position) => (
            <button
              key={index}
              type="button"
              aria-pressed={position === at}
              onClick={() => setAt(position)}
              className="h-5 min-w-5 rounded border border-line px-1 font-mono text-[11px] leading-none text-fg-muted aria-pressed:border-accent aria-pressed:bg-selected aria-pressed:text-fg"
            >
              {index + 1}
            </button>
          ))}
        </div>
      ) : null}
      <div className="grid gap-3 md:grid-cols-2">
        <OutputPane
          label="Baseline"
          trial={pair.baseline}
          spans={spans}
          keep="removed"
          inExperiment={row.baseline !== null}
        />
        <OutputPane
          label="Candidate"
          trial={pair.candidate}
          spans={spans}
          keep="added"
          inExperiment={row.candidate !== null}
        />
      </div>
    </div>
  );
}

function OutputPane({
  label,
  trial,
  spans,
  keep,
  inExperiment,
}: {
  label: string;
  trial: GridTrial | undefined;
  spans: DiffSpan[];
  /** The changed words that this side has. */
  keep: "added" | "removed";
  inExperiment: boolean;
}) {
  const mark =
    keep === "added"
      ? "rounded-sm bg-success/20 text-fg"
      : "rounded-sm bg-danger/20 text-fg line-through decoration-danger/60";
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md border border-line bg-rail p-3">
      <span className="flex items-center gap-2 text-xs text-fg-subtle">
        {label}
        {trial ? <span>· trial {trial.index + 1}</span> : null}
      </span>
      {!trial ? (
        <p className="text-ui text-fg-subtle">
          {inExperiment ? "No trial with this number" : "Not in this experiment"}
        </p>
      ) : trial.result === "invalid" ? (
        <p className="text-ui text-warning">Invalid: {trial.reason}</p>
      ) : (
        <p className="text-sm leading-relaxed break-words whitespace-pre-wrap text-fg">
          {trial.output === null ? (
            <span className="text-fg-faint">No output</span>
          ) : (
            spans.map((span, index) =>
              span.op === "same" ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: the spans of a diff never change their order
                <span key={index}>{span.text}</span>
              ) : span.op === keep ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: the spans of a diff never change their order
                <mark key={index} className={mark}>
                  {span.text}
                </mark>
              ) : null,
            )
          )}
        </p>
      )}
      {trial && trial.scorers.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {trial.scorers.map((scorer) => (
            <li key={scorer.scorerId}>
              <Badge tone={SCORER_TONE[scorer.status]}>
                {scorer.name}: {scorer.status === "not_scored" ? "not scored" : scorer.status}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
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
  trial: GridTrial | undefined;
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
