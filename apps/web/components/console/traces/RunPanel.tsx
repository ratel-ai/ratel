"use client";

import { StatusDot } from "@ratel/design-system/badge";
import { Button } from "@ratel/design-system/button";
import { buttonVariants } from "@ratel/design-system/button-variants";
import { cn } from "@ratel/design-system/cn";
import { Panel } from "@ratel/design-system/panel";
import { StatRow } from "@ratel/design-system/stat-row";
import { Callout, Skeleton } from "@ratel/design-system/states";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  formatDuration,
  formatInteger,
  formatMoney,
  formatRelativeTime,
} from "@/lib/synthesis/traces/v2/format";
import {
  isFreshSummary,
  SUMMARY_READ_DELAY_MS,
  type SummaryEntry,
  summaryKey,
} from "@/lib/synthesis/traces/v2/run-panel";
import type { RunStep, RunSummary } from "@/lib/synthesis/traces/v2/run-summary";
import type { RunSummaryResult } from "@/lib/synthesis/traces/v2/run-summary-route";
import { INCOMPLETE_HINT, RUN_STATUS_LABEL, type RunRow } from "@/lib/synthesis/traces/v2/runs";
import { KIND_DOT } from "./kind";

export const CONTENT_CAPTURE_DOCS = "https://docs.ratel.sh/observability#content-capture";

const LOAD_FAILED: RunSummaryResult = {
  ok: false,
  message: "Couldn't load this run. Try again in a moment.",
};

/** Loads one run's summary; the summary route in the app, a stub in tests. Aborted when the Panel moves on. */
export type LoadRunSummary = (
  projectId: string,
  traceId: string,
  signal?: AbortSignal,
) => Promise<RunSummaryResult>;

/**
 * Inspect a run without leaving the list (DESIGN.md, Overlays): what was
 * asked, each step in order with its duration, what the agent answered, with
 * failures marked. `j` and `k` move to the next and previous run.
 *
 * A run is read when the Panel rests on it (a moment after `j` or `k`), the
 * read is abandoned when the Panel moves on, and a run that has not finished
 * is read again when reopened (lib/traces/v2/run-panel.ts).
 */
export function RunPanel({
  projectId,
  openId,
  rows,
  now,
  traceHref,
  loadSummary,
  onOpen,
  onClose,
}: {
  projectId: string;
  /** The run in the URL's `?peek=`, or null when closed. */
  openId: string | null;
  rows: readonly RunRow[];
  now: string;
  traceHref: (id: string) => string;
  loadSummary: LoadRunSummary;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  // Keep showing the last run while the Panel animates closed.
  const [lastId, setLastId] = useState(openId);
  if (openId && openId !== lastId) setLastId(openId);
  const shownId = openId ?? lastId;
  const index = rows.findIndex((row) => row.id === shownId);
  const row = index >= 0 ? rows[index] : null;
  // Per run and per span count the list showed: a list with more spans reads it again.
  const key = shownId ? summaryKey(shownId, row?.spanCount) : null;
  const [entries, setEntries] = useState<ReadonlyMap<string, SummaryEntry>>(() => new Map());
  const entry = key ? entries.get(key) : undefined;

  useEffect(() => {
    if (!openId || !key) return;
    if (entry && isFreshSummary(entry, Date.now())) return;
    const controller = new AbortController();
    // Rest a moment first: holding j or k never reads the runs it passes. A
    // stale run stays on screen meanwhile.
    const timer = setTimeout(() => {
      loadSummary(projectId, openId, controller.signal)
        .catch((): RunSummaryResult => LOAD_FAILED)
        .then((result) => {
          if (controller.signal.aborted) return;
          setEntries((current) => new Map(current).set(key, { result, at: Date.now() }));
        });
    }, SUMMARY_READ_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [openId, key, entry, projectId, loadSummary]);

  const result = entry?.result;
  const summary = result?.ok ? result.summary : null;
  // The summary is read after the list, so it knows better whether the run has ended.
  const status = summary?.status ?? row?.status ?? null;
  const step = (direction: 1 | -1) => {
    const next = rows[index + direction];
    if (next) onOpen(next.id);
  };

  return (
    <Panel
      open={openId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={row?.title ?? summary?.title ?? "Run"}
      subtitle={
        status ? (
          <>
            {RUN_STATUS_LABEL[status]}
            {status === "incomplete" ? ` (${INCOMPLETE_HINT.toLowerCase()})` : null}
            {row
              ? ` · ${formatRelativeTime(row.startedAt, now)} · ${formatDuration(row.durationMs)}`
              : null}
          </>
        ) : undefined
      }
      actions={
        shownId ? (
          <Link
            href={traceHref(shownId)}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            Open full trace
          </Link>
        ) : null
      }
      onPrevious={index > 0 ? () => step(-1) : undefined}
      onNext={index >= 0 && index < rows.length - 1 ? () => step(1) : undefined}
    >
      {!result ? (
        <RunSummarySkeleton />
      ) : result.ok ? (
        <RunSummaryBody
          summary={result.summary}
          truncated={result.truncated}
          fullTraceHref={shownId ? traceHref(shownId) : null}
        />
      ) : (
        <Callout
          tone="danger"
          title={result.message}
          action={
            key ? (
              <Button
                size="sm"
                onClick={() =>
                  setEntries(
                    (current) => new Map([...current].filter(([cached]) => cached !== key)),
                  )
                }
              >
                Try again
              </Button>
            ) : null
          }
        />
      )}
    </Panel>
  );
}

export function RunSummaryBody({
  summary,
  truncated,
  fullTraceHref,
}: {
  summary: RunSummary;
  truncated: boolean;
  fullTraceHref: string | null;
}) {
  const stepCount = summary.steps.length + summary.hiddenStepCount;
  return (
    <div className="flex flex-col gap-5" data-run-summary>
      <StatRow
        stats={[
          { label: "Duration", value: formatDuration(summary.totals.durationMs) },
          { label: "Steps", value: formatInteger(stepCount) },
          { label: "Tokens", value: formatInteger(summary.totals.tokens) },
          { label: "Cost", value: formatMoney(summary.totals.costUsd) },
        ]}
      />

      {!summary.contentCaptured ? (
        <Callout
          title="Message content isn't captured"
          action={
            <a
              href={CONTENT_CAPTURE_DOCS}
              target="_blank"
              rel="noreferrer"
              className="text-ui font-medium text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg-subtle"
            >
              How to turn it on
            </a>
          }
        >
          The steps below still show what the agent did. Turn on capture to also see what it was
          asked and answered.
        </Callout>
      ) : null}

      {summary.ask ? <Message label="Asked" text={summary.ask} /> : null}

      <section aria-label="Steps" className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-fg">Steps</h3>
        {summary.steps.length === 0 ? (
          <p className="text-sm text-fg-muted">
            This run made no model calls, tool calls or searches.
          </p>
        ) : (
          <ol className="relative flex flex-col">
            {summary.steps.map((step, position) => (
              <StepRow key={step.id} step={step} last={position === summary.steps.length - 1} />
            ))}
          </ol>
        )}
        {summary.hiddenStepCount > 0 && fullTraceHref ? (
          <Link
            href={fullTraceHref}
            className="text-ui text-fg-muted underline decoration-line-strong underline-offset-4 hover:text-fg"
          >
            {formatInteger(summary.hiddenStepCount)} more steps in the full trace
          </Link>
        ) : null}
        {truncated ? (
          <p className="text-xs text-fg-subtle">
            This run is long; the steps come from its first 5,000 spans.
          </p>
        ) : null}
      </section>

      {summary.runError ? (
        <p className="flex items-center gap-2 text-sm text-fg">
          <StatusDot tone="danger" label="The run failed" />
          <code className="font-mono text-xs text-fg-muted">{summary.runError}</code>
        </p>
      ) : null}

      {summary.answer ? <Message label="Answered" text={summary.answer} /> : null}
    </div>
  );
}

function Message({ label, text }: { label: string; text: string }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-fg-subtle">{label}</h3>
      <p className="rounded-lg border border-line bg-raised px-3 py-2.5 text-sm whitespace-pre-wrap text-fg">
        {text}
      </p>
    </section>
  );
}

function StepRow({ step, last }: { step: RunStep; last: boolean }) {
  return (
    <li
      className="relative flex gap-3 pb-3"
      data-step-kind={step.kind}
      data-failed={step.failed || undefined}
    >
      {/* The thread that ties the steps into one story. */}
      {!last ? (
        <span aria-hidden className="absolute top-4 bottom-0 left-[3px] w-px bg-line" />
      ) : null}
      <span
        aria-hidden
        className={cn(
          "relative mt-1.5 size-[7px] shrink-0 rounded-full",
          step.failed ? "bg-danger" : KIND_DOT[step.kind],
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-ui">
          <span className="shrink-0 text-fg-subtle">{step.label}</span>
          <span className="min-w-0 flex-1 truncate text-fg" title={step.title}>
            {step.title}
          </span>
          <span className="shrink-0 text-fg-muted tabular-nums">
            {formatDuration(step.durationMs)}
          </span>
        </div>
        {step.detail || step.failed ? (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
            {step.failed ? (
              <span className="inline-flex items-center gap-1.5">
                <StatusDot tone="danger" label="Failed" className="text-xs" />
                {step.errorType ? (
                  <code className="font-mono text-fg-muted">{step.errorType}</code>
                ) : null}
              </span>
            ) : null}
            {step.detail ? <span className="tabular-nums">{step.detail}</span> : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function RunSummarySkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true">
      <span className="sr-only">Loading the run…</span>
      <Skeleton className="h-[84px] w-full rounded-lg" />
      <Skeleton className="h-12 w-full rounded-lg" />
      <div className="flex flex-col gap-3">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="flex items-center gap-3">
            <Skeleton className="size-2 rounded-full" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-3 w-12" />
          </div>
        ))}
      </div>
    </div>
  );
}
